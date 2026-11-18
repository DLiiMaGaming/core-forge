// graphql.ts — a hand-rolled GraphQL v4 executor for the documents gh and
// github-mcp-server actually send.
//
// Tokenizer + recursive-descent parser + a resolver-table executor. Only the
// schema surface the suite drives is implemented; unknown fields answer null
// with an error entry, and HTTP status stays 200 for GraphQL-level errors.

import {
  VIEWER_ID,
  VIEWER_LOGIN,
  globalId,
  parseGlobalId,
  type Forge,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { branchTip, refCommit } from './gitcore.ts';
import {
  hasAuth,
  mergePullRequest,
  pullFiles,
  pullMergeable,
  sendJson,
  type RequestContext,
} from './app.ts';

export const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'comments', 'createdAt', 'updatedAt', 'closed', 'labels', 'repository', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'author', 'createdAt', 'updatedAt', 'closed', 'additions', 'deletions', 'changedFiles'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url'],
  User: ['login', 'id', 'name', 'databaseId'],
  Ref: ['name', 'target'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
};

export const TYPE_ENUMS: Record<string, string[]> = {
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

// ---- tokenizer --------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number; raw: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:$!@='.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3);
      const raw = end < 0 ? source.slice(i + 3) : source.slice(i + 3, end);
      i = end < 0 ? source.length : end + 3;
      tokens.push({ kind: 'string', value: dedentBlockString(raw) });
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
          value += map[esc] ?? esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
      if (match) {
        tokens.push({ kind: 'number', value: Number(match[0]), raw: match[0] });
        i += match[0].length;
        continue;
      }
    }
    if (isNameStart(ch)) {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

/** GraphQL block-string dedent: drop blank first/last lines, strip common indent. */
function dedentBlockString(raw: string): string {
  const lines = raw.split('\n');
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  let minIndent: number | null = null;
  for (let k = 1; k < lines.length; k += 1) {
    const line = lines[k];
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    minIndent = minIndent === null ? indent : Math.min(minIndent, indent);
  }
  if (minIndent !== null && minIndent > 0) {
    for (let k = 1; k < lines.length; k += 1) lines[k] = lines[k].slice(minIndent);
  }
  return lines.join('\n');
}

// ---- parser -----------------------------------------------------------------

type Selection =
  | { kind: 'field'; name: string; alias?: string; args: Record<string, unknown>; selections?: Selection[] }
  | { kind: 'spread'; name: string; selections?: Selection[] }
  | { kind: 'inline'; typeCondition?: string; selections: Selection[] };

interface Operation {
  kind: string;
  name?: string;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition?: string; selections: Selection[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private peekPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  /** Skip a balanced (...) list (variable definitions, directive arguments). */
  private skipParens(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  /** Skip directives: @name and an optional argument list. */
  private skipDirectives(): void {
    while (this.peekPunct('@')) {
      this.next();
      this.expectName();
      if (this.peekPunct('(')) this.skipParens();
    }
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition?: string; selections: Selection[] }>();
    while (this.pos < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const kind = token.value;
        this.next();
        let name: string | undefined;
        const next = this.peek();
        if (next?.kind === 'name') {
          name = this.next().value as string;
        }
        if (this.peekPunct('(')) this.skipParens();
        this.skipDirectives();
        operations.push({ kind, name, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected on in fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(name, { typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected token ${token.kind} ${'value' in token ? token.value : ''}`);
    }
    return { operations, fragments };
  }

  parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.peekPunct('}')) {
      if (this.pos >= this.tokens.length) throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  parseSelection(): Selection {
    if (this.peekPunct('...')) {
      this.next();
      const token = this.peek();
      if (token?.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (token?.kind === 'name') {
        const name = this.next().value as string;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.peekPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName();
    }
    let args: Record<string, unknown> = {};
    if (this.peekPunct('(')) args = this.parseArguments();
    this.skipDirectives();
    let selections: Selection[] | undefined;
    if (this.peekPunct('{')) selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  parseArguments(): Record<string, unknown> {
    this.expectPunct('(');
    const args: Record<string, unknown> = {};
    while (!this.peekPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  parseValue(): unknown {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { $var: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: unknown[] = [];
      while (!this.peekPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return items;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const obj: Record<string, unknown> = {};
      while (!this.peekPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        obj[name] = this.parseValue();
      }
      this.expectPunct('}');
      return obj;
    }
    if (token.kind === 'string') return token.value;
    if (token.kind === 'number') return token.value;
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value;
    }
    throw new Error('unexpected value');
  }
}

// ---- execution --------------------------------------------------------------

interface GqlNode {
  __type: string;
  [key: string]: unknown;
}

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition?: string; selections: Selection[] }>;
  errors: { message: string }[];
}

type Resolver = (source: GqlNode, args: Record<string, unknown>, ctx: ExecContext) => unknown;

function resolveVariables(value: unknown, variables: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveVariables(item, variables));
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.$var === 'string') return variables[obj.$var];
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(obj)) out[key] = resolveVariables(item, variables);
    return out;
  }
  return value;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorAfter(after: unknown): number | null {
  if (typeof after !== 'string') return null;
  try {
    const text = Buffer.from(after, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function pageOf<T>(items: T[], args: Record<string, unknown>, key: (item: T) => number): { nodes: T[]; hasNextPage: boolean; endCursor: string | null } {
  // The page starts after the item with the cursor's number, in list order —
  // position-based, so it works for ascending and descending lists alike.
  const after = cursorAfter(args.after);
  let start = 0;
  if (after !== null) {
    const at = items.findIndex((item) => key(item) === after);
    start = at >= 0 ? at + 1 : 0;
  }
  const rest = items.slice(start);
  const firstRaw = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : rest.length;
  const page = rest.slice(0, firstRaw);
  const hasNextPage = rest.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(key(page[page.length - 1])) : null;
  return { nodes: page, hasNextPage, endCursor };
}

function connectionNode(nodes: GqlNode[], hasNextPage: boolean, endCursor: string | null, nodeType: string): GqlNode {
  return {
    __type: nodeType,
    nodes,
    pageInfo: { __type: 'PageInfo', hasNextPage, endCursor },
  };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ __type: 'User', login: VIEWER_LOGIN, id: VIEWER_ID }),
    repository: (_src, args, ctx) => {
      const repo = ctx.forge.repoByKey(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? { __type: 'Repository', repo } : null;
    },
    node: (_src, args, ctx) => {
      const parsed = typeof args.id === 'string' ? parseGlobalId(args.id) : null;
      if (!parsed) return null;
      const repo = ctx.forge.repoById(parsed.repoId);
      if (!repo) return null;
      if (parsed.kind === 'repo') return { __type: 'Repository', repo };
      if (parsed.kind === 'issue' && parsed.number !== undefined) {
        const issue = repo.issues.get(parsed.number);
        return issue ? { __type: 'Issue', repo, issue } : null;
      }
      if (parsed.kind === 'pull' && parsed.number !== undefined) {
        const pull = repo.pulls.get(parsed.number);
        return pull ? { __type: 'PullRequest', repo, pull } : null;
      }
      return null;
    },
    __type: (_src, args) => {
      const name = String(args.name ?? '');
      if (TYPE_FIELDS[name]) return { __type: '__Type', name, kind: 'OBJECT' };
      if (TYPE_ENUMS[name]) return { __type: '__Type', name, kind: 'ENUM' };
      return null;
    },
    __schema: () => ({ __type: '__Schema' }),
  },
  Mutation: {
    createIssue: (_src, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = parsed?.kind === 'repo' ? ctx.forge.repoById(parsed.repoId) : undefined;
      if (!repo) throw new Error('repository not found for createIssue');
      const issue = ctx.forge.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { __type: 'CreateIssuePayload', issue: { __type: 'Issue', repo, issue } };
    },
    closeIssue: (_src, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = typeof input.issueId === 'string' ? parseGlobalId(input.issueId) : null;
      const repo = parsed ? ctx.forge.repoById(parsed.repoId) : undefined;
      const issue = parsed?.kind === 'issue' && parsed.number !== undefined ? repo?.issues.get(parsed.number) : undefined;
      if (!issue || !repo) throw new Error('issue not found for closeIssue');
      issue.state = 'closed';
      return { __type: 'CloseIssuePayload', issue: { __type: 'Issue', repo, issue } };
    },
    createPullRequest: (_src, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = parsed?.kind === 'repo' ? ctx.forge.repoById(parsed.repoId) : undefined;
      if (!repo) throw new Error('repository not found for createPullRequest');
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = refCommit(ctx.forge, repo, `refs/heads/${headRef}`);
      const baseSha = refCommit(ctx.forge, repo, `refs/heads/${baseRef}`);
      if (headSha === null || baseSha === null) throw new Error('head or base branch not found for createPullRequest');
      const pull = ctx.forge.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), headRef, baseRef, headSha, baseSha);
      return { __type: 'CreatePullRequestPayload', pullRequest: { __type: 'PullRequest', repo, pull } };
    },
    mergePullRequest: (_src, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = typeof input.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
      const repo = parsed ? ctx.forge.repoById(parsed.repoId) : undefined;
      const pull = parsed?.kind === 'pull' && parsed.number !== undefined ? repo?.pulls.get(parsed.number) : undefined;
      if (!pull || !repo) throw new Error('pull request not found for mergePullRequest');
      if (!pull.merged) {
        const sha = mergePullRequest(ctx.forge, repo, pull);
        if (sha === null) throw new Error('pull request is not mergeable');
      }
      return { __type: 'MergePullRequestPayload', pullRequest: { __type: 'PullRequest', repo, pull } };
    },
    addComment: (_src, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
      const repo = parsed ? ctx.forge.repoById(parsed.repoId) : undefined;
      const issue = parsed?.kind === 'issue' && parsed.number !== undefined ? repo?.issues.get(parsed.number) : undefined;
      if (!issue || !repo) throw new Error('subject not found for addComment');
      const comment = { id: issue.nextCommentId, body: String(input.body ?? ''), createdSeq: ctx.forge.nextSeq() };
      issue.nextCommentId += 1;
      issue.comments.push(comment);
      return {
        __type: 'AddCommentPayload',
        commentEdge: {
          __type: 'IssueCommentEdge',
          node: { __type: 'IssueComment', id: globalId('comment', repo.id, issue.number, comment.id), body: comment.body },
        },
      };
    },
  },
  User: {
    login: (src) => src.login,
    id: (src) => Buffer.from(`user:${src.id as number}`, 'utf8').toString('base64'),
    name: (src, _args, ctx) => ctx.forge.users.get(String(src.login))?.name ?? String(src.login),
    databaseId: (src) => src.id,
  },
  Repository: {
    id: (src) => globalId('repo', (src.repo as RepoRec).id),
    databaseId: (src) => (src.repo as RepoRec).id,
    name: (src) => (src.repo as RepoRec).name,
    nameWithOwner: (src) => `${(src.repo as RepoRec).owner}/${(src.repo as RepoRec).name}`,
    owner: (src) => ({ __type: 'User', login: (src.repo as RepoRec).owner, id: 0 }),
    defaultBranchRef: (src, _args, ctx) => {
      const repo = src.repo as RepoRec;
      return branchTip(ctx.forge, repo, repo.defaultBranch) !== null ? { __type: 'Ref', name: repo.defaultBranch } : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (src) => (src.repo as RepoRec).description,
    isPrivate: (src) => (src.repo as RepoRec).isPrivate,
    issue: (src, args, ctx) => {
      const repo = src.repo as RepoRec;
      const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
      return issue ? { __type: 'Issue', repo, issue } : null;
    },
    issues: (src, args, ctx) => {
      const repo = src.repo as RepoRec;
      let list = [...repo.issues.values()];
      if (Array.isArray(args.states)) {
        const wanted = new Set(args.states.map((state) => String(state).toLowerCase()));
        list = list.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      list.sort((a, b) => a.number - b.number);
      if (String(orderBy.direction ?? 'DESC').toUpperCase() !== 'ASC') list.reverse();
      const page = pageOf(list, args, (issue) => issue.number);
      return connectionNode(
        page.nodes.map((issue) => ({ __type: 'Issue', repo, issue })),
        page.hasNextPage,
        page.endCursor,
        'Connection',
      );
    },
    pullRequest: (src, args, ctx) => {
      const repo = src.repo as RepoRec;
      const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
      return pull ? { __type: 'PullRequest', repo, pull } : null;
    },
    pullRequests: (src, args, ctx) => {
      const repo = src.repo as RepoRec;
      const list = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
      const page = pageOf(list, args, (pull) => pull.number);
      return connectionNode(
        page.nodes.map((pull) => ({ __type: 'PullRequest', repo, pull })),
        page.hasNextPage,
        page.endCursor,
        'Connection',
      );
    },
  },
  Issue: {
    id: (src) => globalId('issue', (src.repo as RepoRec).id, (src.issue as IssueRec).number),
    number: (src) => (src.issue as IssueRec).number,
    title: (src) => (src.issue as IssueRec).title,
    body: (src) => (src.issue as IssueRec).body,
    state: (src) => (src.issue as IssueRec).state.toUpperCase(),
    closed: (src) => (src.issue as IssueRec).state === 'closed',
  },
  PullRequest: {
    id: (src) => globalId('pull', (src.repo as RepoRec).id, (src.pull as PullRec).number),
    number: (src) => (src.pull as PullRec).number,
    title: (src) => (src.pull as PullRec).title,
    body: (src) => (src.pull as PullRec).body,
    state: (src) => {
      const pull = src.pull as PullRec;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (src) => (src.pull as PullRec).merged,
    headRefName: (src) => (src.pull as PullRec).headRef,
    baseRefName: (src) => (src.pull as PullRec).baseRef,
    mergeable: (src, _args, ctx) => pullMergeable(ctx.forge, src.repo as RepoRec, src.pull as PullRec),
    files: (src, args, ctx) => {
      const repo = src.repo as RepoRec;
      const pull = src.pull as PullRec;
      const diffs = pullFiles(ctx.forge, repo, pull);
      // Files paginate by position: the cursor holds the last index served.
      const after = cursorAfter(args.after);
      const start = after === null ? 0 : after + 1;
      const firstRaw = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : diffs.length;
      const page = diffs.slice(start, start + firstRaw);
      const hasNextPage = start + page.length < diffs.length;
      const endCursor = page.length > 0 ? cursorFor(start + page.length - 1) : null;
      const nodes = page.map((diff) => ({ __type: 'PullRequestChangedFile', path: diff.filename }));
      return connectionNode(nodes, hasNextPage, endCursor, 'PullRequestChangedFileConnection');
    },
  },
  Ref: {
    name: (src) => src.name,
  },
  IssueComment: {
    id: (src) => src.id,
    body: (src) => src.body,
  },
  IssueCommentEdge: {
    node: (src) => src.node,
  },
  Connection: {
    nodes: (src) => src.nodes,
    pageInfo: (src) => src.pageInfo,
    totalCount: (src) => (src.nodes as unknown[]).length,
  },
  PullRequestChangedFileConnection: {
    nodes: (src) => src.nodes,
    pageInfo: (src) => src.pageInfo,
    totalCount: (src) => (src.nodes as unknown[]).length,
  },
  PullRequestChangedFile: {
    path: (src) => src.path,
  },
  __Type: {
    name: (src) => src.name,
    kind: (src) => src.kind,
    fields: (src) => (TYPE_FIELDS[String(src.name)] ?? []).map((name) => ({ __type: '__Field', name })),
    enumValues: (src) => (TYPE_ENUMS[String(src.name)] ?? []).map((name) => ({ __type: '__EnumValue', name })),
  },
  __Field: {
    name: (src) => src.name,
  },
  __EnumValue: {
    name: (src) => src.name,
  },
  __Schema: {
    types: () => [],
    queryType: () => ({ __type: '__Type', name: 'Query', kind: 'OBJECT' }),
    mutationType: () => ({ __type: '__Type', name: 'Mutation', kind: 'OBJECT' }),
  },
  PageInfo: {
    hasNextPage: (src) => src.hasNextPage,
    hasPreviousPage: () => false,
    startCursor: () => null,
    endCursor: (src) => src.endCursor,
  },
  CreateIssuePayload: {
    issue: (src) => src.issue,
  },
  CloseIssuePayload: {
    issue: (src) => src.issue,
  },
  CreatePullRequestPayload: {
    pullRequest: (src) => src.pullRequest,
  },
  MergePullRequestPayload: {
    pullRequest: (src) => src.pullRequest,
  },
  AddCommentPayload: {
    commentEdge: (src) => src.commentEdge,
  },
};

function completeValue(value: unknown, selections: Selection[] | undefined, ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, selections, ctx));
  if (typeof value === 'object') {
    const node = value as GqlNode;
    if (typeof node.__type === 'string') {
      if (!selections) return value;
      return completeSelection(node, selections, ctx);
    }
    return value;
  }
  return value;
}

function completeSelection(source: GqlNode, selections: Selection[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (!fragment) continue;
      if (fragment.typeCondition && fragment.typeCondition !== source.__type) continue;
      Object.assign(out, completeSelection(source, fragment.selections, ctx));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition && selection.typeCondition !== source.__type) continue;
      Object.assign(out, completeSelection(source, selection.selections, ctx));
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = source.__type;
      continue;
    }
    const resolver = RESOLVERS[source.__type]?.[selection.name];
    if (!resolver) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${source.__type}'` });
      out[key] = null;
      continue;
    }
    const args = resolveVariables(selection.args, ctx.variables) as Record<string, unknown>;
    let value: unknown;
    try {
      value = resolver(source, args, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(value, selection.selections, ctx);
  }
  return out;
}

function executeRequest(
  forge: Forge,
  request: Record<string, unknown>,
): Record<string, unknown> {
  const errors: { message: string }[] = [];
  const query = request.query;
  if (typeof query !== 'string') return { errors: [{ message: 'query must be a string' }] };
  let document: Document;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (document.operations.length === 0) return { errors: [{ message: 'no operation in document' }] };
  const operationName = typeof request.operationName === 'string' ? request.operationName : undefined;
  const operation =
    document.operations.find((op) => op.name === operationName) ?? document.operations[0];
  const variables = (request.variables ?? {}) as Record<string, unknown>;
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const ctx: ExecContext = { forge, variables, fragments: document.fragments, errors };
  const data = completeSelection({ __type: rootType }, operation.selections, ctx);
  const result: Record<string, unknown> = { data };
  if (errors.length > 0) result.errors = errors;
  return result;
}

// ---- HTTP entry point -------------------------------------------------------

export async function handleGraphql(forge: Forge, ctx: RequestContext): Promise<void> {
  const { res } = ctx;
  // Auth is enforced here (GraphQL's 401 wording differs from REST's).
  if (!hasAuth(ctx.req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }
  if (ctx.body.malformed || (ctx.body.json === null && ctx.body.jsonArray === null)) {
    sendJson(res, 400, { errors: [{ message: 'request body must be a JSON object or array' }] });
    return;
  }
  const requests = ctx.body.jsonArray ?? [ctx.body.json as Record<string, unknown>];
  const answers = requests.map((request) =>
    request !== null && typeof request === 'object' && !Array.isArray(request)
      ? executeRequest(forge, request as Record<string, unknown>)
      : { errors: [{ message: 'request body must be a JSON object or array' }] },
  );
  sendJson(res, 200, ctx.body.jsonArray ? answers : answers[0]);
}
