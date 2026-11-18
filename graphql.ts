// graphql.ts — the GraphQL v4 surface (POST /api/graphql): a small hand-rolled parser and
// executor covering exactly the document shapes gh and github-mcp-server send (queries with
// variables, aliases, inline fragments, input objects, enum lists, batched operations, and the
// __type introspection probes), resolved against the same store the REST surface serves.

import type { ServerResponse } from 'node:http';
import type { Ctx, RequestData } from './app.ts';
import { mergePullRequest, pullFiles, pullMergeable } from './app.ts';
import type { Forge, IssueRec, PullRec, RepoRec } from './store.ts';

// --------------------------------------------------------------------------- syntax tree

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface FieldNode {
  name: string;
  alias?: string;
  args: { name: string; value: Value }[];
  selection?: SelectionItem[];
}

type SelectionItem =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition?: string; selection: SelectionItem[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  selection: SelectionItem[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition?: string; selection: SelectionItem[] }>;
}

class GqlSyntaxError extends Error {}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < input.length && input[i] !== '\n') i += 1; continue; }
    if (input.startsWith('...', i)) { tokens.push('...'); i += 3; continue; }
    if ('{}()[]:$!@='.includes(ch)) { tokens.push(ch); i += 1; continue; }
    if (ch === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        if (end === -1) throw new GqlSyntaxError('unterminated block string');
        tokens.push(`"${input.slice(i + 3, end)}"`);
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) { out += input[j] + input[j + 1]; j += 2; }
        else { out += input[j]; j += 1; }
      }
      if (j >= input.length) throw new GqlSyntaxError('unterminated string');
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    const nameMatch = /^[_A-Za-z][_0-9A-Za-z]*/.exec(input.slice(i));
    if (nameMatch) { tokens.push(nameMatch[0]); i += nameMatch[0].length; continue; }
    const numMatch = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(input.slice(i));
    if (numMatch) { tokens.push(numMatch[0]); i += numMatch[0].length; continue; }
    throw new GqlSyntaxError(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined { return this.tokens[this.pos]; }
  private next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new GqlSyntaxError('unexpected end of document');
    this.pos += 1;
    return token;
  }
  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new GqlSyntaxError(`expected ${token}, got ${got}`);
  }
  private skipBalanced(open: string, close: string): void {
    let depth = 0;
    for (;;) {
      const token = this.next();
      if (token === open) depth += 1;
      else if (token === close) { depth -= 1; if (depth === 0) return; }
    }
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition?: string; selection: SelectionItem[] }>();
    while (this.pos < this.tokens.length) {
      const head = this.peek();
      if (head === '{') {
        operations.push({ type: 'query', selection: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation' || head === 'subscription') {
        this.next();
        let name: string | undefined;
        if (this.peek() !== '(' && this.peek() !== '{' && this.peek() !== undefined) name = this.next();
        if (this.peek() === '(') this.skipBalanced('(', ')');
        // Directives on the operation: skip `@name` plus optional argument list.
        while (this.peek() === '@') { this.next(); this.next(); if (this.peek() === '(') this.skipBalanced('(', ')'); }
        operations.push({ type: head === 'mutation' ? 'mutation' : 'query', name, selection: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        const typeCondition = this.next();
        while (this.peek() === '@') { this.next(); this.next(); if (this.peek() === '(') this.skipBalanced('(', ')'); }
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
      } else {
        throw new GqlSyntaxError(`unexpected token ${head}`);
      }
    }
    return { operations, fragments };
  }

  private parseSelectionSet(): SelectionItem[] {
    this.expect('{');
    const items: SelectionItem[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          items.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else {
          items.push({ kind: 'spread', name: this.next() });
        }
        continue;
      }
      items.push({ kind: 'field', field: this.parseField() });
    }
    this.expect('}');
    return items;
  }

  private parseField(): FieldNode {
    let name = this.next();
    let alias: string | undefined;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: FieldNode['args'] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    while (this.peek() === '@') { this.next(); this.next(); if (this.peek() === '(') this.skipBalanced('(', ')'); }
    let selection: SelectionItem[] | undefined;
    if (this.peek() === '{') selection = this.parseSelectionSet();
    return { name, alias, args, selection };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'var', name: this.next() };
    if (token.startsWith('"')) {
      try { return { kind: 'string', value: JSON.parse(token) as string }; }
      catch { return { kind: 'string', value: token.slice(1, -1) }; }
    }
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true' || token === 'false') return { kind: 'bool', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d*\.\d+/.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var': return variables[value.name];
    case 'string': return value.value;
    case 'int': case 'float': return value.value;
    case 'bool': return value.value;
    case 'null': return null;
    case 'enum': return value.value;
    case 'list': return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// --------------------------------------------------------------------------- schema (for __type)

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'comments', 'createdAt', 'updatedAt', 'closed', 'labels', 'repository', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'author', 'createdAt', 'updatedAt', 'closed', 'additions', 'deletions', 'changedFiles'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url'],
  User: ['login', 'id', 'name', 'databaseId'],
  Ref: ['name', 'target'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'MARKETPLACE', 'ORGANIZATION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  IssueOrderFieldUnused: [],
};

// --------------------------------------------------------------------------- execution

interface GqlObject {
  __type: string;
  [key: string]: unknown;
}

interface ExecCtx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition?: string; selection: SelectionItem[] }>;
  errors: { message: string }[];
}

function obj(type: string, fields: Record<string, unknown>): GqlObject {
  return { __type: type, ...fields };
}

function repoObject(forge: Forge, repo: RepoRec): GqlObject {
  return obj('Repository', { repo });
}
function issueObject(forge: Forge, repo: RepoRec, issue: IssueRec): GqlObject {
  return obj('Issue', { repo, issue });
}
function pullObject(forge: Forge, repo: RepoRec, pull: PullRec): GqlObject {
  return obj('PullRequest', { repo, pull });
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

type Resolver = (ctx: ExecCtx, source: GqlObject, args: Record<string, unknown>, field: FieldNode) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (ctx) => obj('User', { login: ctx.forge.viewer.login, id: ctx.forge.viewer.id }),
    repository: (ctx, _s, args) => {
      const repo = ctx.forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? repoObject(ctx.forge, repo) : null;
    },
    node: (ctx, _s, args) => {
      const parsed = ctx.forge.parseGlobalId(String(args.id ?? ''));
      if (!parsed) return null;
      const repo = ctx.forge.repoById(parsed.repoId);
      if (!repo) return null;
      if (parsed.kind === 'repo') return repoObject(ctx.forge, repo);
      if (parsed.kind === 'issue') {
        const issue = repo.issues.get(parsed.number ?? -1);
        return issue ? issueObject(ctx.forge, repo, issue) : null;
      }
      if (parsed.kind === 'pull') {
        const pull = repo.pulls.get(parsed.number ?? -1);
        return pull ? pullObject(ctx.forge, repo, pull) : null;
      }
      return null;
    },
    __type: (_ctx, _s, args) => {
      const name = String(args.name ?? '');
      if (TYPE_FIELDS[name]) return obj('__Type', { name, kind: 'OBJECT' });
      if (TYPE_ENUMS[name]) return obj('__Type', { name, kind: 'ENUM' });
      return null;
    },
    __schema: () => obj('__Schema', {}),
  },
  Mutation: {
    createIssue: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = ctx.forge.parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed ? ctx.forge.repoById(parsed.repoId) : undefined;
      if (!repo) throw new Error('repository not found for createIssue');
      const issue = ctx.forge.createIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
      return obj('CreateIssuePayload', { issue: issueObject(ctx.forge, repo, issue) });
    },
    closeIssue: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = ctx.forge.parseGlobalId(String(input.issueId ?? ''));
      const repo = parsed ? ctx.forge.repoById(parsed.repoId) : undefined;
      const issue = repo && parsed?.number !== undefined ? repo.issues.get(parsed.number) : undefined;
      if (!repo || !issue) throw new Error('issue not found for closeIssue');
      issue.state = 'closed';
      return obj('CloseIssuePayload', { issue: issueObject(ctx.forge, repo, issue) });
    },
    createPullRequest: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = ctx.forge.parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed ? ctx.forge.repoById(parsed.repoId) : undefined;
      if (!repo) throw new Error('repository not found for createPullRequest');
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = ctx.forge.refCommit(repo, `refs/heads/${headRef}`);
      const baseSha = ctx.forge.refCommit(repo, `refs/heads/${baseRef}`);
      if (!headSha || !baseSha) throw new Error('head or base branch not found for createPullRequest');
      const pull = ctx.forge.createPull(repo, {
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        headRef,
        baseRef,
        headSha,
        baseSha,
      });
      return obj('CreatePullRequestPayload', { pullRequest: pullObject(ctx.forge, repo, pull) });
    },
    mergePullRequest: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = ctx.forge.parseGlobalId(String(input.pullRequestId ?? ''));
      const repo = parsed ? ctx.forge.repoById(parsed.repoId) : undefined;
      const pull = repo && parsed?.number !== undefined ? repo.pulls.get(parsed.number) : undefined;
      if (!repo || !pull) throw new Error('pull request not found for mergePullRequest');
      if (!pull.merged) {
        const sha = mergePullRequest(ctx.forge, repo, pull);
        if (!sha) throw new Error('pull request is not mergeable');
      }
      return obj('MergePullRequestPayload', { pullRequest: pullObject(ctx.forge, repo, pull) });
    },
    addComment: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = ctx.forge.parseGlobalId(String(input.subjectId ?? ''));
      const repo = parsed ? ctx.forge.repoById(parsed.repoId) : undefined;
      const issue = repo && parsed?.number !== undefined ? repo.issues.get(parsed.number) : undefined;
      if (!repo || !issue) throw new Error('subject not found for addComment');
      const comment = { id: issue.nextCommentId, body: String(input.body ?? ''), createdSeq: ctx.forge.nextSeq() };
      issue.nextCommentId += 1;
      issue.comments.push(comment);
      const node = obj('IssueComment', { id: ctx.forge.globalId('comment', repo, issue.number, comment.id), body: comment.body });
      return obj('AddCommentPayload', { commentEdge: obj('IssueCommentEdge', { node }) });
    },
  },
  User: {
    login: (_ctx, source) => source.login,
    id: (ctx, source) => Buffer.from(`user:${source.id ?? ctx.forge.viewer.id}`).toString('base64'),
    name: (ctx, source) => ctx.forge.users.get(String(source.login))?.name ?? source.login,
    databaseId: (_ctx, source) => source.id,
  },
  Repository: {
    id: (ctx, source) => ctx.forge.globalId('repo', source.repo as RepoRec),
    databaseId: (_ctx, source) => (source.repo as RepoRec).id,
    name: (_ctx, source) => (source.repo as RepoRec).name,
    nameWithOwner: (_ctx, source) => `${(source.repo as RepoRec).owner}/${(source.repo as RepoRec).name}`,
    owner: (_ctx, source) => obj('User', { login: (source.repo as RepoRec).owner, id: 0 }),
    defaultBranchRef: (ctx, source) => {
      const repo = source.repo as RepoRec;
      return ctx.forge.defaultTip(repo) ? obj('Ref', { name: repo.defaultBranch }) : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (_ctx, source) => (source.repo as RepoRec).description,
    isPrivate: (_ctx, source) => (source.repo as RepoRec).isPrivate,
    issue: (ctx, source, args) => {
      const repo = source.repo as RepoRec;
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueObject(ctx.forge, repo, issue) : null;
    },
    issues: (ctx, source, args) => {
      const repo = source.repo as RepoRec;
      let list = [...repo.issues.values()];
      const states = args.states as string[] | undefined;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((s) => s.toLowerCase()));
        list = list.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
      const direction = orderBy?.direction ?? 'DESC';
      list.sort((a, b) => a.number - b.number);
      if (direction !== 'ASC') list.reverse();
      return connection(ctx, list.map((issue) => issueObject(ctx.forge, repo, issue)), args, (item) => (item.issue as IssueRec).number);
    },
    pullRequest: (ctx, source, args) => {
      const repo = source.repo as RepoRec;
      const pull = repo.pulls.get(Number(args.number));
      return pull ? pullObject(ctx.forge, repo, pull) : null;
    },
    pullRequests: (ctx, source, args) => {
      const repo = source.repo as RepoRec;
      const list = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
      return connection(ctx, list.map((pull) => pullObject(ctx.forge, repo, pull)), args, (item) => (item.pull as PullRec).number);
    },
  },
  Issue: {
    id: (ctx, source) => ctx.forge.globalId('issue', source.repo as RepoRec, (source.issue as IssueRec).number),
    number: (_ctx, source) => (source.issue as IssueRec).number,
    title: (_ctx, source) => (source.issue as IssueRec).title,
    body: (_ctx, source) => (source.issue as IssueRec).body,
    state: (_ctx, source) => (source.issue as IssueRec).state.toUpperCase(),
    closed: (_ctx, source) => (source.issue as IssueRec).state === 'closed',
  },
  PullRequest: {
    id: (ctx, source) => ctx.forge.globalId('pull', source.repo as RepoRec, (source.pull as PullRec).number),
    number: (_ctx, source) => (source.pull as PullRec).number,
    title: (_ctx, source) => (source.pull as PullRec).title,
    body: (_ctx, source) => (source.pull as PullRec).body,
    state: (_ctx, source) => {
      const pull = source.pull as PullRec;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (_ctx, source) => (source.pull as PullRec).merged,
    headRefName: (_ctx, source) => (source.pull as PullRec).headRef,
    baseRefName: (_ctx, source) => (source.pull as PullRec).baseRef,
    mergeable: (ctx, source) => pullMergeable(ctx.forge, source.repo as RepoRec, source.pull as PullRec),
    files: (ctx, source, args) => {
      const files = pullFiles(ctx.forge, source.repo as RepoRec, source.pull as PullRec);
      const first = typeof args.first === 'number' ? args.first : files.length;
      return obj('PullRequestChangedFileConnection', {
        nodesRaw: files.slice(0, first).map((file) => obj('PullRequestChangedFile', { path: file.filename })),
      });
    },
  },
  PullRequestChangedFile: {
    path: (_ctx, source) => source.path,
  },
  Ref: {
    name: (_ctx, source) => source.name,
  },
  IssueComment: {
    id: (_ctx, source) => source.id,
    body: (_ctx, source) => source.body,
  },
  __Type: {
    name: (_ctx, source) => source.name,
    kind: (_ctx, source) => source.kind,
    fields: (_ctx, source) => (TYPE_FIELDS[String(source.name)] ?? []).map((name) => obj('__Field', { name })),
    enumValues: (_ctx, source) => (TYPE_ENUMS[String(source.name)] ?? []).map((name) => obj('__EnumValue', { name })),
  },
  PageInfo: {
    hasNextPage: (_ctx, source) => source.hasNextPage,
    hasPreviousPage: () => false,
    startCursor: () => null,
    endCursor: (_ctx, source) => source.endCursor,
  },
  CreateIssuePayload: { issue: (_ctx, source) => source.issue },
  CloseIssuePayload: { issue: (_ctx, source) => source.issue },
  CreatePullRequestPayload: { pullRequest: (_ctx, source) => source.pullRequest },
  MergePullRequestPayload: { pullRequest: (_ctx, source) => source.pullRequest },
  AddCommentPayload: { commentEdge: (_ctx, source) => source.commentEdge },
  IssueCommentEdge: { node: (_ctx, source) => source.node },
  __Field: { name: (_ctx, source) => source.name },
  __EnumValue: { name: (_ctx, source) => source.name },
  __Schema: {
    types: () => [],
    queryType: () => obj('__Type', { name: 'Query', kind: 'OBJECT' }),
    mutationType: () => obj('__Type', { name: 'Mutation', kind: 'OBJECT' }),
  },
};

// Connection wrappers are resolved specially (nodes/pageInfo are synthetic fields).
function connection(ctx: ExecCtx, items: GqlObject[], args: Record<string, unknown>, numberOf: (item: GqlObject) => number): GqlObject {
  void ctx;
  let startIndex = 0;
  const after = args.after;
  if (typeof after === 'string' && after !== '') {
    try {
      const decoded = Buffer.from(after, 'base64').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(decoded);
      if (match) {
        const index = items.findIndex((item) => numberOf(item) === Number(match[1]));
        if (index !== -1) startIndex = index + 1;
      }
    } catch { /* foreign cursor: start from the beginning */ }
  }
  const first = typeof args.first === 'number' ? args.first : items.length;
  const page = items.slice(startIndex, startIndex + Math.max(0, first));
  const hasNextPage = startIndex + page.length < items.length;
  const endCursor = page.length > 0 ? cursorFor(numberOf(page[page.length - 1])) : null;
  return obj('Connection', { nodesRaw: page, pageInfoRaw: { hasNextPage, endCursor } });
}

function executeSelection(ctx: ExecCtx, typeName: string, source: GqlObject | null, selection: SelectionItem[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of selection) {
    if (item.kind === 'inline') {
      if (!item.typeCondition || !source || source.__type === item.typeCondition) {
        Object.assign(out, executeSelection(ctx, item.typeCondition ?? typeName, source, item.selection));
      }
      continue;
    }
    if (item.kind === 'spread') {
      const fragment = ctx.fragments.get(item.name);
      if (fragment && (!fragment.typeCondition || !source || source.__type === fragment.typeCondition)) {
        Object.assign(out, executeSelection(ctx, fragment.typeCondition ?? typeName, source, fragment.selection));
      }
      continue;
    }
    const field = item.field;
    const key = field.alias ?? field.name;
    const args: Record<string, unknown> = {};
    for (const arg of field.args) args[arg.name] = resolveValue(arg.value, ctx.variables);

    // Synthetic connection fields.
    if (source && (source.__type === 'Connection')) {
      if (field.name === 'nodes') {
        const nodes = (source.nodesRaw as GqlObject[]).map((node) => executeSelection(ctx, node.__type, node, field.selection ?? []));
        out[key] = nodes;
        continue;
      }
      if (field.name === 'pageInfo') {
        out[key] = executeSelection(ctx, 'PageInfo', obj('PageInfo', source.pageInfoRaw as Record<string, unknown>), field.selection ?? []);
        continue;
      }
      if (field.name === 'totalCount') { out[key] = (source.nodesRaw as GqlObject[]).length; continue; }
    }
    if (source && source.__type === 'PullRequestChangedFileConnection' && field.name === 'nodes') {
      out[key] = (source.nodesRaw as GqlObject[]).map((node) => executeSelection(ctx, node.__type, node, field.selection ?? []));
      continue;
    }
    if (field.name === '__typename') { out[key] = source?.__type ?? typeName; continue; }

    const resolver = RESOLVERS[typeName]?.[field.name] ?? (source ? RESOLVERS[source.__type]?.[field.name] : undefined);
    if (!resolver) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${source?.__type ?? typeName}'` });
      out[key] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolver(ctx, source ?? obj(typeName, {}), args, field);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, value, field);
  }
  return out;
}

function completeValue(ctx: ExecCtx, value: unknown, field: FieldNode): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(ctx, item, field));
  if (typeof value === 'object' && (value as GqlObject).__type) {
    const gqlObj = value as GqlObject;
    if (!field.selection) return gqlObj;
    return executeSelection(ctx, gqlObj.__type, gqlObj, field.selection);
  }
  return value;
}

function runOperation(forge: Forge, document: Document, operationName: string | undefined, variables: Record<string, unknown>): Record<string, unknown> {
  const operation = document.operations.find((op) => !operationName || op.name === operationName) ?? document.operations[0];
  if (!operation) return { errors: [{ message: 'no operation in document' }] };
  const ctx: ExecCtx = { forge, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(ctx, rootType, obj(rootType, {}), operation.selection);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

export async function handleGraphQL(
  ctx: Ctx,
  req: RequestData,
  res: ServerResponse,
  sendJson: (res: ServerResponse, status: number, body: unknown, headers?: Readonly<Record<string, string>>) => void,
): Promise<void> {
  if (req.method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }); return; }
  if (!req.authed) { sendJson(res, 401, { message: 'Bad credentials' }); return; }
  const runOne = (payload: Record<string, unknown>): Record<string, unknown> => {
    const query = typeof payload.query === 'string' ? payload.query : '';
    const variables = (payload.variables !== null && typeof payload.variables === 'object' && !Array.isArray(payload.variables))
      ? payload.variables as Record<string, unknown>
      : {};
    const operationName = typeof payload.operationName === 'string' ? payload.operationName : undefined;
    try {
      const document = new Parser(tokenize(query)).parseDocument();
      return runOperation(ctx.forge, document, operationName, variables);
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  if (req.jsonArray) {
    sendJson(res, 200, req.jsonArray.map((entry) => runOne((entry ?? {}) as Record<string, unknown>)));
    return;
  }
  if (!req.json) {
    sendJson(res, 400, { errors: [{ message: 'request body must be a JSON object or array' }] });
    return;
  }
  sendJson(res, 200, runOne(req.json));
}
