// app.ts — the HTTP surface: routing, REST v3, git smart HTTP.
//
// One server, four surfaces, one store: git smart HTTP at /{owner}/{repo}.git,
// REST v3 under /api/v3, GraphQL at /api/graphql (graphql.ts) and MCP at /mcp
// (mcp.ts). Routes are matched against a small table; every response carries
// an X-GitHub-Request-Id counter value, and every error body is JSON with a
// string message (git transport answers are the plain-text exception).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  COMMIT_AUTHOR,
  VIEWER_ID,
  VIEWER_LOGIN,
  commentRestId,
  globalId,
  isoNoMillis,
  restId,
  Forge,
  type CommentRec,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import {
  ZERO_OID,
  branchTip,
  buildTreeFromFiles,
  commitFiles,
  filesAt,
  flattenTree,
  isAncestor,
  mergeBase,
  mergeFileMaps,
  objectClosure,
  parseCommit,
  parseTree,
  peelToCommit,
  readPack,
  refCommit,
  subtreeAt,
  writePack,
  type FileMap,
} from './gitcore.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY = 128 * 1024 * 1024;
const REQUEST_ID_PREFIX = 'core-forge-';

let requestCounter = 0;

/** Next request-id value: core-forge-00000001, counting up, zero-padded. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `${REQUEST_ID_PREFIX}${requestCounter.toString(16).padStart(8, '0')}`;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(text);
}

function sendText(res: ServerResponse, status: number, text: string, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** Read the whole request body (rejects past 128 MiB; the caller turns it into 500). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export interface ParsedBody {
  json: Record<string, unknown> | null;
  jsonArray: unknown[] | null;
  malformed: boolean;
}

/** Split a body into object / array / malformed, per the wire contract. */
export function parseBody(raw: Buffer): ParsedBody {
  if (raw.length === 0) return { json: null, jsonArray: null, malformed: false };
  try {
    const value: unknown = JSON.parse(raw.toString('utf8'));
    if (Array.isArray(value)) return { json: null, jsonArray: value, malformed: false };
    if (value !== null && typeof value === 'object') {
      return { json: value as Record<string, unknown>, jsonArray: null, malformed: false };
    }
    return { json: null, jsonArray: null, malformed: false };
  } catch {
    return { json: null, jsonArray: null, malformed: true };
  }
}

/** Path segments: split on '/', drop empties, URL-decode each (kept raw on error). */
export function pathSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

export interface RequestContext {
  forge: Forge;
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  segments: string[];
  query: URLSearchParams;
  host: string;
  rawBody: Buffer;
  body: ParsedBody;
}

/** Any non-empty token authenticates; the value is never compared. */
export function hasAuth(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || header === '') return false;
  const token = header.replace(/^(?:bearer|token)\s+/i, '').trim();
  return token !== '';
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBool(value: unknown): boolean {
  return value === true;
}

// ---- serializers ----------------------------------------------------------

function userView(forge: Forge, login: string): { login: string; id: number; type: string } {
  return { login, id: forge.users.get(login)?.id ?? 0, type: 'User' };
}

export function serializeRepo(forge: Forge, repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('repo', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: userView(forge, repo.owner),
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://forge.local/${repo.owner}/${repo.name}`,
    created_at: forge.isoAt(repo.createdSeq),
    updated_at: forge.isoAt(repo.createdSeq),
  };
}

export function serializeIssue(forge: Forge, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: restId(repo.id, issue.number),
    node_id: globalId('issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({
      name,
      color: repo.labels.get(name)?.color ?? '000000',
    })),
    user: userView(forge, VIEWER_LOGIN),
    comments: issue.comments.length,
    created_at: forge.isoAt(issue.createdSeq),
    updated_at: forge.isoAt(issue.createdSeq),
    html_url: `https://forge.local/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function serializeComment(
  forge: Forge,
  repo: RepoRec,
  issue: IssueRec,
  comment: CommentRec,
): Record<string, unknown> {
  return {
    id: commentRestId(repo.id, issue.number, comment.id),
    node_id: globalId('comment', repo.id, issue.number, comment.id),
    body: comment.body,
    user: userView(forge, VIEWER_LOGIN),
    created_at: forge.isoAt(comment.createdSeq),
    updated_at: forge.isoAt(comment.createdSeq),
    html_url: `https://forge.local/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
  };
}

export function serializePull(forge: Forge, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = branchTip(forge, repo, pull.headRef) ?? pull.createdHeadSha;
  const baseSha = branchTip(forge, repo, pull.baseRef) ?? pull.createdBaseSha;
  return {
    id: restId(repo.id, pull.number),
    node_id: globalId('pull', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: userView(forge, VIEWER_LOGIN),
    created_at: forge.isoAt(pull.createdSeq),
    updated_at: forge.isoAt(pull.createdSeq),
    html_url: `https://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

// ---- pagination -----------------------------------------------------------

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page')) || 30));
  const page = Math.max(1, Number(query.get('page')) || 1);
  return { perPage, page };
}

/** Slice a list and build the GitHub-style Link header (only when a link exists). */
function paginate<T>(
  items: T[],
  query: URLSearchParams,
  basePath: string,
  host: string,
): { page: T[]; link: string | null } {
  const { perPage, page } = pageParams(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const links: string[] = [];
  const urlFor = (p: number): string => `<http://${host}${basePath}?per_page=${perPage}&page=${p}>`;
  if (page < totalPages) {
    links.push(`${urlFor(page + 1)}; rel="next"`);
    links.push(`${urlFor(totalPages)}; rel="last"`);
  }
  if (page > 1) {
    links.push(`${urlFor(page - 1)}; rel="prev"`);
    links.push(`${urlFor(1)}; rel="first"`);
  }
  return { page: slice, link: links.length > 0 ? links.join(', ') : null };
}

// ---- shared lookups -------------------------------------------------------

function lookupRepo(ctx: RequestContext, owner: string, name: string): RepoRec | null {
  return ctx.forge.repoByKey(owner, name) ?? null;
}

function requireRepo(ctx: RequestContext, owner: string, name: string): RepoRec | null {
  const repo = lookupRepo(ctx, owner, name);
  if (!repo) notFound(ctx.res);
  return repo;
}

function parseNumberParam(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  return Number(value);
}

function stripOwnerPrefix(ref: string): string {
  const at = ref.indexOf(':');
  return at >= 0 ? ref.slice(at + 1) : ref;
}

/** Resolve a ref query to a peeled commit: default tip, ref name, or raw oid. */
export function resolveRefCommit(forge: Forge, repo: RepoRec, ref: string | null): string | null {
  if (ref === null) return branchTip(forge, repo, repo.defaultBranch);
  const byName = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref);
  if (byName !== undefined) return peelToCommit(forge, byName);
  if (forge.hasObject(ref)) return peelToCommit(forge, ref);
  return null;
}

// ---- pull requests: diff and merge ----------------------------------------

interface FileDiff {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  patch: string;
}

/** Line diff: LCS walk, deletion preferred on ties; capped at 4000 lines. */
function diffLines(aText: string, bText: string): { additions: number; deletions: number; patch: string } {
  const a = aText === '' ? [] : aText.split('\n');
  const b = bText === '' ? [] : bText.split('\n');
  const header = `@@ -1,${a.length} +1,${b.length} @@`;
  if (a.length > 4000 || b.length > 4000) {
    return { additions: b.length, deletions: a.length, patch: header };
  }
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines: string[] = [header];
  let additions = 0;
  let deletions = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push(`-${a[i]}`);
      deletions += 1;
      i += 1;
    } else {
      lines.push(`+${b[j]}`);
      additions += 1;
      j += 1;
    }
  }
  while (i < a.length) {
    lines.push(`-${a[i]}`);
    deletions += 1;
    i += 1;
  }
  while (j < b.length) {
    lines.push(`+${b[j]}`);
    additions += 1;
    j += 1;
  }
  return { additions, deletions, patch: lines.join('\n') };
}

export function pullFiles(forge: Forge, repo: RepoRec, pull: PullRec): FileDiff[] {
  const baseTip = branchTip(forge, repo, pull.baseRef) ?? pull.createdBaseSha;
  const headTip = branchTip(forge, repo, pull.headRef) ?? pull.createdHeadSha;
  const base = mergeBase(forge, baseTip, headTip) ?? baseTip;
  const baseFiles = filesAt(forge, base);
  const headFiles = filesAt(forge, headTip);
  const paths = [...new Set([...baseFiles.keys(), ...headFiles.keys()])].sort();
  const out: FileDiff[] = [];
  for (const path of paths) {
    const from = baseFiles.get(path);
    const to = headFiles.get(path);
    if (from && to && from.oid === to.oid && from.mode === to.mode) continue;
    const fromText = from ? forge.getObject(from.oid)?.data.toString('utf8') ?? '' : '';
    const toText = to ? forge.getObject(to.oid)?.data.toString('utf8') ?? '' : '';
    const diff = diffLines(fromText, toText);
    out.push({
      filename: path,
      status: !from ? 'added' : !to ? 'removed' : 'modified',
      additions: diff.additions,
      deletions: diff.deletions,
      changes: diff.additions + diff.deletions,
      patch: diff.patch,
    });
  }
  return out;
}

/**
 * Squash-merge a pull request: single-parent commit on the base branch,
 * message "<title> (#<n>)" plus the body. Returns the merge commit oid,
 * or null when the merge cannot run (missing tips, no base, conflict).
 */
export function mergePullRequest(forge: Forge, repo: RepoRec, pull: PullRec): string | null {
  const baseTip = branchTip(forge, repo, pull.baseRef);
  const headTip = branchTip(forge, repo, pull.headRef);
  if (baseTip === null || headTip === null) return null;
  const base = mergeBase(forge, baseTip, headTip);
  if (base === null) return null;
  const conflicts: string[] = [];
  const merged = mergeFileMaps(filesAt(forge, base), filesAt(forge, baseTip), filesAt(forge, headTip), conflicts);
  if (merged === null) return null;
  let message = `${pull.title} (#${pull.number})`;
  if (pull.body !== '') message += `\n\n${pull.body}`;
  const commitOid = commitFiles(forge, merged, baseTip, message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.nowIso();
  pull.mergeCommitSha = commitOid;
  return commitOid;
}

/** Mergeability without mutating anything (GraphQL `mergeable`). */
export function pullMergeable(forge: Forge, repo: RepoRec, pull: PullRec): string {
  if (pull.state === 'closed') return 'UNKNOWN';
  const baseTip = branchTip(forge, repo, pull.baseRef);
  const headTip = branchTip(forge, repo, pull.headRef);
  if (baseTip === null || headTip === null) return 'UNKNOWN';
  const base = mergeBase(forge, baseTip, headTip);
  if (base === null) return 'CONFLICTING';
  const conflicts: string[] = [];
  const merged = mergeFileMaps(filesAt(forge, base), filesAt(forge, baseTip), filesAt(forge, headTip), conflicts);
  return merged === null ? 'CONFLICTING' : 'MERGEABLE';
}

// ---- REST v3 ---------------------------------------------------------------

type Handler = (ctx: RequestContext, params: Record<string, string>) => void;

interface Route {
  method: string;
  template: string[];
  handler: Handler;
}

const routes: Route[] = [];

/** Register a route; ':name' matches one segment, ':name...' the rest joined with '/'. */
function route(method: string, template: string, handler: Handler): void {
  routes.push({ method, template: template.split('/').filter((part) => part !== ''), handler });
}

function matchRoute(ctx: RequestContext): { handler: Handler; params: Record<string, string> } | null {
  for (const candidate of routes) {
    if (candidate.method !== ctx.method) continue;
    const params: Record<string, string> = {};
    let ok = true;
    let i = 0;
    for (; i < candidate.template.length; i += 1) {
      const part = candidate.template[i];
      if (part.endsWith('...')) {
        params[part.slice(1, -3)] = ctx.segments.slice(i).join('/');
        i = ctx.segments.length;
        break;
      }
      if (i >= ctx.segments.length) {
        ok = false;
        break;
      }
      if (part.startsWith(':')) params[part.slice(1)] = ctx.segments[i];
      else if (part !== ctx.segments[i]) {
        ok = false;
        break;
      }
    }
    if (ok && i === ctx.segments.length) return { handler: candidate.handler, params };
  }
  return null;
}

function validationError(res: ServerResponse, message: string): void {
  jsonError(res, 422, message);
}

function labelsFromBody(ctx: RequestContext): string[] {
  const raw = ctx.body.json?.labels;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string');
}

function unknownLabels(repo: RepoRec, names: string[]): string[] {
  return names.filter((name) => !repo.labels.has(name));
}

// -- API root, meta, user ----------------------------------------------------

route('GET', '', (ctx) => {
  sendJson(ctx.res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
});

route('GET', 'meta', (ctx) => {
  sendJson(ctx.res, 200, { installed_version: '1.0.0-core-forge', verifiable_password_authentication: false });
});

route('GET', 'user', (ctx) => {
  sendJson(ctx.res, 200, {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    name: 'ada iversen',
    type: 'User',
    node_id: Buffer.from(`user:${VIEWER_ID}`, 'utf8').toString('base64'),
  });
});

// -- repositories ------------------------------------------------------------

route('GET', 'user/repos', (ctx) => {
  const repos = ctx.forge.reposOf(VIEWER_LOGIN);
  const { page, link } = paginate(repos, ctx.query, '/api/v3/user/repos', ctx.host);
  const extra = link ? { link } : {};
  sendJson(ctx.res, 200, page.map((repo) => serializeRepo(ctx.forge, repo)), extra);
});

route('POST', 'user/repos', (ctx) => {
  const name = asString(ctx.body.json?.name);
  if (name === undefined || name === '') {
    validationError(ctx.res, 'Validation Failed: name is required');
    return;
  }
  if (ctx.forge.repoByKey(VIEWER_LOGIN, name)) {
    sendJson(ctx.res, 422, {
      message: 'Validation Failed: name already exists on this account',
      errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
    });
    return;
  }
  const repo = ctx.forge.createRepo(
    VIEWER_LOGIN,
    name,
    asString(ctx.body.json?.description) ?? '',
    asBool(ctx.body.json?.private),
  );
  sendJson(ctx.res, 201, serializeRepo(ctx.forge, repo));
});

route('GET', 'repos/:o/:r', (ctx, p) => {
  const repo = requireRepo(ctx, p.o, p.r);
  if (repo) sendJson(ctx.res, 200, serializeRepo(ctx.forge, repo));
});

route('PATCH', 'repos/:o/:r', (ctx, p) => {
  const repo = requireRepo(ctx, p.o, p.r);
  if (!repo) return;
  const description = ctx.body.json?.description;
  if (typeof description === 'string') repo.description = description;
  const isPrivate = ctx.body.json?.private;
  if (typeof isPrivate === 'boolean') repo.isPrivate = isPrivate;
  sendJson(ctx.res, 200, serializeRepo(ctx.forge, repo));
});

route('DELETE', 'repos/:o/:r', (ctx, p) => {
  const repo = requireRepo(ctx, p.o, p.r);
  if (!repo) return;
  ctx.forge.deleteRepo(repo);
  ctx.res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  ctx.res.end();
});

// -- branches and refs -------------------------------------------------------

route('GET', 'repos/:o/:r/branches', (ctx, p) => {
  const repo = requireRepo(ctx, p.o, p.r);
  if (!repo) return;
  const branches = [...repo.refs.entries()]
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .map(([ref, oid]) => ({
      name: ref.slice('refs/heads/'.length),
      commit: { sha: peelToCommit(ctx.forge, oid) ?? oid },
      protected: false,
    }));
  sendJson(ctx.res, 200, branches);
});

route('GET', 'repos/:o/:r/branches/:rest...', (ctx, p) => {
  const repo = requireRepo(ctx, p.o, p.r);
  if (!repo) return;
  const oid = repo.refs.get(`refs/heads/${p.rest}`);
  if (oid === undefined) {
    notFound(ctx.res);
    return;
  }
  sendJson(ctx.res, 200, {
    name: p.rest,
    commit: { sha: peelToCommit(ctx.forge, oid) ?? oid },
    protected: false,
  });
});

route('GET', 'repos/:o/:r/git/refs', (ctx, p) => {
  const repo = requireRepo(ctx, p.o, p.r);
  if (!repo) return;
  sendJson(
    ctx.res,
    200,
    [...repo.refs.entries()].map(([ref, oid]) => ({
      ref,
      object: { sha: oid, type: ctx.forge.getObject(oid)?.type ?? 'commit' },
    })),
  );
});

route('POST', 'repos/:o/:r/git/refs', (ctx, p) => {
  const repo = requireRepo(ctx, p.o, p.r);
  if (!repo) return;
  const ref = asString(ctx.body.json?.ref);
  const sha = asString(ctx.body.json?.sha);
  if (ref === undefined || !ref.startsWith('refs/') || sha === undefined || !ctx.forge.hasObject(sha)) {
    validationError(ctx.res, 'Validation Failed: invalid ref or sha');
    return;
  }
  if (repo.refs.has(ref)) {
    validationError(ctx.res, 'Validation Failed: Reference already exists');
    return;
  }
  repo.refs.set(ref, sha);
  sendJson(ctx.res, 201, { ref, object: { sha, type: ctx.forge.getObject(sha)?.type ?? 'commit' } });
});

route('GET', 'repos/:o/:r/git/refs/:rest...', (ctx, p) => {
  const repo = requireRepo(ctx, p.o, p.r);
  if (!repo) return;
  const ref = `refs/${p.rest}`;
  const oid = repo.refs.get(ref);
  if (oid === undefined) {
    notFound(ctx.res);
    return;
  }
  sendJson(ctx.res, 200, { ref, object: { sha: oid, type: ctx.forge.getObject(oid)?.type ?? 'commit' } });
});

// -- commits -----------------------------------------------------------------

route('GET', 'repos/:o/:r/commits', (ctx, p) => {
  const repo = requireRepo(ctx, p.o, p.r);
  if (!repo) return;
  const shaParam = ctx.query.get('sha');
  let start: string | null = null;
  if (shaParam === null) {
    start = branchTip(ctx.forge, repo, repo.defaultBranch);
  } else {
    const byName = repo.refs.get(`refs/heads/${shaParam}`) ?? repo.refs.get(shaParam);
    if (byName !== undefined) start = peelToCommit(ctx.forge, byName);
    else if (ctx.forge.hasObject(shaParam)) start = peelToCommit(ctx.forge, shaParam);
  }
  const entries: Record<string, unknown>[] = [];
  if (start !== null) {
    const seen = new Set<string>();
    const queue = [start];
    for (let head = 0; head < queue.length; head += 1) {
      const oid = queue[head];
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = ctx.forge.getObject(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parsed = parseCommit(obj.data);
      const authorLine = /^author (.*?) <(.*?)> (\d+) /m.exec(obj.data.toString('utf8'));
      const person = authorLine
        ? {
            name: authorLine[1],
            email: authorLine[2],
            date: isoNoMillis(Number(authorLine[3]) * 1000),
          }
        : { name: '', email: '', date: ctx.forge.isoAt(repo.createdSeq) };
      entries.push({
        sha: oid,
        commit: {
          message: parsed.message.replace(/\n$/, ''),
          tree: { sha: parsed.tree },
          author: person,
          committer: person,
        },
        parents: parsed.parents.map((parent) => ({ sha: parent })),
      });
      for (const parent of parsed.parents) queue.push(parent);
    }
  }
  const { page, link } = paginate(entries, ctx.query, `/api/v3/repos/${p.o}/${p.r}/commits`, ctx.host);
  sendJson(ctx.res, 200, page, link ? { link } : {});
});

// -- contents ----------------------------------------------------------------

function contentsFileObject(path: string, blobOid: string, data: Buffer): Record<string, unknown> {
  return {
    type: 'file',
    name: path.split('/').pop() ?? path,
    path,
    sha: blobOid,
    size: data.length,
    encoding: 'base64',
    content: data.toString('base64'),
  };
}

route('GET', 'repos/:o/:r/contents', (ctx, p) => {
  const repo = requireRepo(ctx, p.o, p.r);
  if (!repo) return;
  const commitOid = resolveRefCommit(ctx.forge, repo, ctx.query.get('ref'));
  if (commitOid === null) {
    notFound(ctx.res);
    return;
  }
  const treeOid = parseCommit(ctx.forge.getObject(commitOid)?.data ?? Buffer.alloc(0)).tree;
  const entries = parseTree(ctx.forge.getObject(treeOid)?.data ?? Buffer.alloc(0))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: entry.name,
      sha: entry.oid,
    }));
  sendJson(ctx.res, 200, entries);
});

route('GET', 'repos/:o/:r/contents/:rest...', (ctx, p) => {
  const repo = requireRepo(ctx, p.o, p.r);
  if (!repo) return;
  const commitOid = resolveRefCommit(ctx.forge, repo, ctx.query.get('ref'));
  if (commitOid === null) {
    notFound(ctx.res);
    return;
  }
  const files = filesAt(ctx.forge, commitOid);
  const found = files.get(p.rest);
  if (found) {
    const data = ctx.forge.getObject(found.oid)?.data ?? Buffer.alloc(0);
    sendJson(ctx.res, 200, contentsFileObject(p.rest, found.oid, data));
    return;
  }
  const treeOid = parseCommit(ctx.forge.getObject(commitOid)?.data ?? Buffer.alloc(0)).tree;
  const dirOid = subtreeAt(ctx.forge, treeOid, p.rest);
  if (dirOid === null) {
    notFound(ctx.res);
    return;
  }
  const entries = parseTree(ctx.forge.getObject(dirOid)?.data ?? Buffer.alloc(0))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: `${p.rest}/${entry.name}`,
      sha: entry.oid,
    }));
  sendJson(ctx.res, 200, entries);
});

route('PUT', 'repos/:o/:r/contents/:rest...', (ctx, p) => {
  const repo = requireRepo(ctx, p.o, p.r);
  if (!repo) return;
  const message = asString(ctx.body.json?.message);
  const content = asString(ctx.body.json?.content);
  if (message === undefined || content === undefined) {
    validationError(ctx.res, 'Validation Failed: message and content are required');
    return;
  }
  const branch = asString(ctx.body.json?.branch) ?? repo.defaultBranch;
  const tip = branchTip(ctx.forge, repo, branch);
  const files = filesAt(ctx.forge, tip);
  const existing = files.get(p.rest);
  const sha = asString(ctx.body.json?.sha);
  if (existing) {
    if (sha === undefined) {
      validationError(ctx.res, 'Validation Failed: sha is required when updating a file');
      return;
    }
    if (sha !== existing.oid) {
      jsonError(ctx.res, 409, 'Conflict: sha does not match the current file');
      return;
    }
  }
  const data = Buffer.from(content.replace(/\s+/g, ''), 'base64');
  const blobOid = ctx.forge.putObject('blob', data);
  files.set(p.rest, { mode: '100644', oid: blobOid });
  const commitOid = commitFiles(ctx.forge, files, tip, message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  sendJson(ctx.res, existing ? 200 : 201, {
    content: { name: p.rest.split('/').pop() ?? p.rest, path: p.rest, sha: blobOid, size: data.length, type: 'file', encoding: 'base64' },
    commit: { sha: commitOid, message },
  });
});

route('DELETE', 'repos/:o/:r/contents/:rest...', (ctx, p) => {
  const repo = requireRepo(ctx, p.o, p.r);
  if (!repo) return;
  const message = asString(ctx.body.json?.message);
  const sha = asString(ctx.body.json?.sha);
  if (message === undefined || sha === undefined) {
    validationError(ctx.res, 'Validation Failed: message and sha are required');
    return;
  }
  const branch = asString(ctx.body.json?.branch) ?? repo.defaultBranch;
  const tip = branchTip(ctx.forge, repo, branch);
  const files = filesAt(ctx.forge, tip);
  const existing = files.get(p.rest);
  if (!existing) {
    notFound(ctx.res);
    return;
  }
  if (sha !== existing.oid) {
    jsonError(ctx.res, 409, 'Conflict: sha does not match the current file');
    return;
  }
  files.delete(p.rest);
  const commitOid = commitFiles(ctx.forge, files, tip, message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  sendJson(ctx.res, 200, { content: null, commit: { sha: commitOid, message } });
});

// -- labels ------------------------------------------------------------------

route('GET', 'repos/:o/:r/labels', (ctx, p) => {
  const repo = requireRepo(ctx, p.o, p.r);
  if (!repo) return;
  sendJson(ctx.res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
});

route('POST', 'repos/:o/:r/labels', (ctx, p) => {
  const repo = requireRepo(ctx, p.o, p.r);
  if (!repo) return;
  const name = asString(ctx.body.json?.name);
  if (name === undefined || name === '') {
    validationError(ctx.res, 'Validation Failed: name is required');
    return;
  }
  if (repo.labels.has(name)) {
    validationError(ctx.res, 'Validation Failed: Label already exists');
    return;
  }
  const color = (asString(ctx.body.json?.color) ?? '000000').replace(/^#/, '');
  repo.labels.set(name, { name, color });
  sendJson(ctx.res, 201, { name, color });
});

// -- issues ------------------------------------------------------------------

route('GET', 'repos/:o/:r/issues', (ctx, p) => {
  const repo = requireRepo(ctx, p.o, p.r);
  if (!repo) return;
  const state = ctx.query.get('state') ?? 'open';
  let issues = [...repo.issues.values()].sort((a, b) => a.number - b.number);
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  if (ctx.query.get('direction') !== 'asc') issues.reverse();
  const { page, link } = paginate(issues, ctx.query, `/api/v3/repos/${p.o}/${p.r}/issues`, ctx.host);
  sendJson(ctx.res, 200, page.map((issue) => serializeIssue(ctx.forge, repo, issue)), link ? { link } : {});
});

route('POST', 'repos/:o/:r/issues', (ctx, p) => {
  const repo = requireRepo(ctx, p.o, p.r);
  if (!repo) return;
  const title = asString(ctx.body.json?.title);
  if (title === undefined || title === '') {
    validationError(ctx.res, 'Validation Failed: title is required');
    return;
  }
  const labels = labelsFromBody(ctx);
  const unknown = unknownLabels(repo, labels);
  if (unknown.length > 0) {
    validationError(ctx.res, `Validation Failed: unknown label ${unknown.join(', ')}`);
    return;
  }
  const issue = ctx.forge.createIssue(repo, title, asString(ctx.body.json?.body) ?? '', labels);
  sendJson(ctx.res, 201, serializeIssue(ctx.forge, repo, issue));
});

route('GET', 'repos/:o/:r/issues/:n', (ctx, p) => {
  const repo = requireRepo(ctx, p.o, p.r);
  if (!repo) return;
  const number = parseNumberParam(p.n);
  const issue = number === null ? undefined : repo.issues.get(number);
  if (!issue) {
    notFound(ctx.res);
    return;
  }
  sendJson(ctx.res, 200, serializeIssue(ctx.forge, repo, issue));
});

route('PATCH', 'repos/:o/:r/issues/:n', (ctx, p) => {
  const repo = requireRepo(ctx, p.o, p.r);
  if (!repo) return;
  const number = parseNumberParam(p.n);
  const issue = number === null ? undefined : repo.issues.get(number);
  if (!issue) {
    notFound(ctx.res);
    return;
  }
  // Mutation order matters: title/body/state apply before label validation,
  // so a 422 on labels still leaves those changes in place.
  const title = ctx.body.json?.title;
  if (typeof title === 'string') issue.title = title;
  const body = ctx.body.json?.body;
  if (typeof body === 'string') issue.body = body;
  const state = ctx.body.json?.state;
  if (state === 'open' || state === 'closed') issue.state = state;
  if (Array.isArray(ctx.body.json?.labels)) {
    const labels = labelsFromBody(ctx);
    const unknown = unknownLabels(repo, labels);
    if (unknown.length > 0) {
      validationError(ctx.res, `Validation Failed: unknown label ${unknown.join(', ')}`);
      return;
    }
    issue.labels = labels;
  }
  sendJson(ctx.res, 200, serializeIssue(ctx.forge, repo, issue));
});

route('GET', 'repos/:o/:r/issues/:n/comments', (ctx, p) => {
  const repo = requireRepo(ctx, p.o, p.r);
  if (!repo) return;
  const number = parseNumberParam(p.n);
  const issue = number === null ? undefined : repo.issues.get(number);
  if (!issue) {
    notFound(ctx.res);
    return;
  }
  sendJson(ctx.res, 200, issue.comments.map((comment) => serializeComment(ctx.forge, repo, issue, comment)));
});

route('POST', 'repos/:o/:r/issues/:n/comments', (ctx, p) => {
  const repo = requireRepo(ctx, p.o, p.r);
  if (!repo) return;
  const number = parseNumberParam(p.n);
  const issue = number === null ? undefined : repo.issues.get(number);
  if (!issue) {
    notFound(ctx.res);
    return;
  }
  const body = asString(ctx.body.json?.body);
  if (body === undefined || body === '') {
    validationError(ctx.res, 'Validation Failed: body is required');
    return;
  }
  const comment: CommentRec = { id: issue.nextCommentId, body, createdSeq: ctx.forge.nextSeq() };
  issue.nextCommentId += 1;
  issue.comments.push(comment);
  sendJson(ctx.res, 201, serializeComment(ctx.forge, repo, issue, comment));
});

// -- pull requests -----------------------------------------------------------

route('GET', 'repos/:o/:r/pulls', (ctx, p) => {
  const repo = requireRepo(ctx, p.o, p.r);
  if (!repo) return;
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  sendJson(ctx.res, 200, pulls.map((pull) => serializePull(ctx.forge, repo, pull)));
});

route('POST', 'repos/:o/:r/pulls', (ctx, p) => {
  const repo = requireRepo(ctx, p.o, p.r);
  if (!repo) return;
  const head = asString(ctx.body.json?.head);
  const base = asString(ctx.body.json?.base);
  const title = ctx.body.json?.title;
  if (head === undefined || head === '' || base === undefined || base === '' || title === undefined) {
    validationError(ctx.res, 'Validation Failed: head, base and title are required');
    return;
  }
  const headRef = stripOwnerPrefix(head);
  const baseRef = stripOwnerPrefix(base);
  const headSha = refCommit(ctx.forge, repo, `refs/heads/${headRef}`);
  if (headSha === null) {
    validationError(ctx.res, 'Validation Failed: head is invalid');
    return;
  }
  const baseSha = refCommit(ctx.forge, repo, `refs/heads/${baseRef}`);
  if (baseSha === null) {
    validationError(ctx.res, 'Validation Failed: base is invalid');
    return;
  }
  const pull = ctx.forge.createPull(repo, title as string, asString(ctx.body.json?.body) ?? '', headRef, baseRef, headSha, baseSha);
  sendJson(ctx.res, 201, serializePull(ctx.forge, repo, pull));
});

route('GET', 'repos/:o/:r/pulls/:n', (ctx, p) => {
  const repo = requireRepo(ctx, p.o, p.r);
  if (!repo) return;
  const number = parseNumberParam(p.n);
  const pull = number === null ? undefined : repo.pulls.get(number);
  if (!pull) {
    notFound(ctx.res);
    return;
  }
  sendJson(ctx.res, 200, serializePull(ctx.forge, repo, pull));
});

route('PATCH', 'repos/:o/:r/pulls/:n', (ctx, p) => {
  const repo = requireRepo(ctx, p.o, p.r);
  if (!repo) return;
  const number = parseNumberParam(p.n);
  const pull = number === null ? undefined : repo.pulls.get(number);
  if (!pull) {
    notFound(ctx.res);
    return;
  }
  const state = ctx.body.json?.state;
  if (state === 'open' || state === 'closed') pull.state = state;
  const title = ctx.body.json?.title;
  if (typeof title === 'string') pull.title = title;
  const body = ctx.body.json?.body;
  if (typeof body === 'string') pull.body = body;
  sendJson(ctx.res, 200, serializePull(ctx.forge, repo, pull));
});

route('GET', 'repos/:o/:r/pulls/:n/files', (ctx, p) => {
  const repo = requireRepo(ctx, p.o, p.r);
  if (!repo) return;
  const number = parseNumberParam(p.n);
  const pull = number === null ? undefined : repo.pulls.get(number);
  if (!pull) {
    notFound(ctx.res);
    return;
  }
  sendJson(ctx.res, 200, pullFiles(ctx.forge, repo, pull));
});

route('PUT', 'repos/:o/:r/pulls/:n/merge', (ctx, p) => {
  const repo = requireRepo(ctx, p.o, p.r);
  if (!repo) return;
  const number = parseNumberParam(p.n);
  const pull = number === null ? undefined : repo.pulls.get(number);
  if (!pull) {
    notFound(ctx.res);
    return;
  }
  if (pull.merged || pull.state === 'closed') {
    jsonError(ctx.res, 405, 'Pull Request is not mergeable: already closed or merged');
    return;
  }
  const sha = mergePullRequest(ctx.forge, repo, pull);
  if (sha === null) {
    jsonError(ctx.res, 405, 'Pull Request is not mergeable: merge conflict');
    return;
  }
  sendJson(ctx.res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
});

/** REST dispatch: public root/meta first, then auth, then malformed JSON, then the table. */
export function restRoutes(ctx: RequestContext): void {
  const isPublicRoot = ctx.segments.length === 0;
  const isPublicMeta = ctx.segments.length === 1 && ctx.segments[0] === 'meta';
  if (!isPublicRoot && !isPublicMeta && !hasAuth(ctx.req)) {
    jsonError(ctx.res, 401, 'Bad credentials');
    return;
  }
  if (ctx.body.malformed) {
    jsonError(ctx.res, 400, 'Problems parsing JSON');
    return;
  }
  const matched = matchRoute(ctx);
  if (!matched) {
    notFound(ctx.res);
    return;
  }
  matched.handler(ctx, matched.params);
}

// ---- git smart HTTP ---------------------------------------------------------

const AGENT_LINE = 'agent=core-forge/1.0';
const UPLOAD_V0_CAPS =
  'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done symref=HEAD:refs/heads/main agent=core-forge/1.0';

/** One pkt-line: 4 lowercase hex digits of (payload length + 4), then the payload. */
function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'utf8');
  return Buffer.concat([head, body]);
}

const FLUSH = Buffer.from('0000', 'utf8');
const DELIM = Buffer.from('0001', 'utf8');

interface PktSection {
  lines: Buffer[];
  next: number;
  terminator: 'flush' | 'delim' | 'end';
}

/** Split a buffer into pkt-lines until flush, delim, or the input ends. */
function parsePktLines(buf: Buffer, start: number): PktSection {
  const lines: Buffer[] = [];
  let pos = start;
  while (pos + 4 <= buf.length) {
    const head = buf.subarray(pos, pos + 4).toString('ascii');
    if (head === '0000') return { lines, next: pos + 4, terminator: 'flush' };
    if (head === '0001') return { lines, next: pos + 4, terminator: 'delim' };
    const length = Number.parseInt(head, 16);
    if (!Number.isFinite(length) || length < 4 || pos + length > buf.length) break;
    lines.push(buf.subarray(pos + 4, pos + length));
    pos += length;
  }
  return { lines, next: pos, terminator: 'end' };
}

function stripLine(line: Buffer): string {
  const text = line.toString('utf8');
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/** v0 ref advertisement: HEAD line, sorted refs, peeled tag lines, flush. */
function v0Advertisement(forge: Forge, repo: RepoRec, capabilities: string): Buffer {
  const parts: Buffer[] = [];
  const tip = branchTip(forge, repo, repo.defaultBranch);
  if (tip !== null) parts.push(pktLine(`${tip} HEAD\0${capabilities}\n`));
  else parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [ref, oid] of refs) {
    parts.push(pktLine(`${oid} ${ref}\n`));
    const obj = forge.getObject(oid);
    if (obj?.type === 'tag') {
      const peeled = peelToCommit(forge, oid);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${ref}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function gitNotFound(res: ServerResponse): void {
  sendText(res, 404, 'not found', 'text/plain');
}

function gitUnauthorized(res: ServerResponse): void {
  sendText(res, 401, 'unauthorized', 'text/plain');
}

/** Repo existence is checked before auth: unknown repo is 404 even unauthenticated. */
function gitRepo(ctx: RequestContext, owner: string, name: string): RepoRec | null {
  const repo = ctx.forge.repoByKey(owner, name);
  if (!repo) {
    gitNotFound(ctx.res);
    return null;
  }
  if (!hasAuth(ctx.req)) {
    gitUnauthorized(ctx.res);
    return null;
  }
  return repo;
}

function handleInfoRefs(ctx: RequestContext, owner: string, name: string): void {
  const repo = gitRepo(ctx, owner, name);
  if (!repo) return;
  const service = ctx.query.get('service');
  if (service === 'git-upload-pack') {
    const protocol = ctx.req.headers['git-protocol'] ?? '';
    if (protocol.includes('version=2')) {
      const body = Buffer.concat([
        pktLine('version 2\n'),
        pktLine(`${AGENT_LINE}\n`),
        pktLine('ls-refs=unborn\n'),
        pktLine('fetch=shallow\n'),
        pktLine('object-format=sha1\n'),
        FLUSH,
      ]);
      sendRaw(ctx.res, 200, body, 'application/x-git-upload-pack-advertisement');
      return;
    }
    const body = Buffer.concat([
      pktLine('# service=git-upload-pack\n'),
      FLUSH,
      v0Advertisement(ctx.forge, repo, UPLOAD_V0_CAPS),
    ]);
    sendRaw(ctx.res, 200, body, 'application/x-git-upload-pack-advertisement');
    return;
  }
  if (service === 'git-receive-pack') {
    const caps = `report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/${repo.defaultBranch} agent=core-forge/1.0`;
    const body = Buffer.concat([
      pktLine('# service=git-receive-pack\n'),
      FLUSH,
      v0Advertisement(ctx.forge, repo, caps),
    ]);
    sendRaw(ctx.res, 200, body, 'application/x-git-receive-pack-advertisement');
    return;
  }
  sendText(ctx.res, 400, 'unknown service', 'text/plain');
}

// ---- upload-pack v2 ---------------------------------------------------------

interface FetchPlan {
  acks: string[];
  shallow: string[];
  unshallow: string[];
  pack: Buffer | null;
}

const packCache = new Map<string, Buffer>();

/** Plan a fetch: acks, shallow boundaries, and the pack to send. */
function planFetch(forge: Forge, repo: RepoRec, args: string[]): FetchPlan {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let deepen: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5));
    else if (arg.startsWith('have ')) haves.push(arg.slice(5));
    else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8));
    else if (arg.startsWith('deepen ')) {
      const n = Number(arg.slice(7));
      if (Number.isFinite(n) && n > 0) deepen = n;
    }
  }
  const shallowSet = new Set(clientShallow);
  const acks = haves.filter((oid) => forge.getObject(oid)?.type === 'commit');
  const held = new Set<string>();
  // Held set: commits the client already has (boundary commits kept, parents not walked).
  {
    const stack = [...haves];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const obj = forge.getObject(oid);
      if (!obj || obj.type !== 'commit') continue;
      seen.add(oid);
      held.add(oid);
      if (shallowSet.has(oid)) continue;
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
  }
  // Peel wants through tags (up to 16 hops), recording tag objects in order.
  const commitWants: string[] = [];
  const tagChain: string[] = [];
  for (const want of wants) {
    let current = want;
    let peeled: string | null = null;
    for (let hop = 0; hop <= 16; hop += 1) {
      const obj = forge.getObject(current);
      if (!obj) break;
      if (obj.type === 'commit') {
        peeled = current;
        break;
      }
      if (obj.type !== 'tag') break;
      tagChain.push(current);
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (!match) break;
      current = match[1];
    }
    if (peeled !== null) commitWants.push(peeled);
  }
  let sendCommits: Set<string>;
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (deepen === null) {
    const closure = new Set<string>();
    const stack = [...commitWants];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (closure.has(oid)) continue;
      const obj = forge.getObject(oid);
      if (!obj || obj.type !== 'commit') continue;
      closure.add(oid);
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
    sendCommits = new Set([...closure].filter((oid) => !held.has(oid)));
  } else {
    const considered = new Set<string>();
    const generation = new Map<string, number>();
    const queue: string[] = [];
    for (const want of commitWants) {
      if (!considered.has(want)) {
        considered.add(want);
        generation.set(want, 1);
        queue.push(want);
      }
    }
    for (let head = 0; head < queue.length; head += 1) {
      const oid = queue[head];
      const gen = generation.get(oid) as number;
      if (gen >= deepen) continue;
      const obj = forge.getObject(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) {
        if (!considered.has(parent)) {
          considered.add(parent);
          generation.set(parent, gen + 1);
          queue.push(parent);
        }
      }
    }
    sendCommits = new Set([...considered].filter((oid) => !held.has(oid)));
    for (const oid of sendCommits) {
      if (generation.get(oid) !== deepen) continue;
      const obj = forge.getObject(oid);
      if (!obj || obj.type !== 'commit') continue;
      if (parseCommit(obj.data).parents.length === 0) continue;
      if (shallowSet.has(oid)) continue;
      shallow.push(oid);
    }
    for (const oid of clientShallow) {
      if (!considered.has(oid)) continue;
      if (shallow.includes(oid)) continue;
      const obj = forge.getObject(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.every((parent) => considered.has(parent) || held.has(parent))) unshallow.push(oid);
    }
  }
  if (sendCommits.size === 0) return { acks, shallow, unshallow, pack: null };
  const cacheKey = [
    [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([ref, oid]) => `${ref}=${oid}`).join(','),
    [...sendCommits].sort().join(','),
    [...held].sort().join(','),
    tagChain.join(','),
  ].join('|');
  const cached = packCache.get(cacheKey);
  if (cached) return { acks, shallow, unshallow, pack: cached };
  const objects = objectClosure(forge, sendCommits, held);
  for (const tagOid of tagChain) {
    const tagObj = forge.getObject(tagOid);
    if (!tagObj) continue;
    const match = /^object ([0-9a-f]{40})$/m.exec(tagObj.data.toString('utf8'));
    if (match && sendCommits.has(match[1])) objects.add(tagOid);
  }
  const ordered = [...sendCommits, ...[...objects].filter((oid) => !sendCommits.has(oid)).sort()];
  const pack = writePack(forge, ordered);
  if (packCache.size >= 64) packCache.clear();
  packCache.set(cacheKey, pack);
  return { acks, shallow, unshallow, pack };
}

function handleUploadPack(ctx: RequestContext, owner: string, name: string): void {
  const repo = gitRepo(ctx, owner, name);
  if (!repo) return;
  const first = parsePktLines(ctx.rawBody, 0);
  if (first.lines.length === 0) {
    sendText(ctx.res, 400, 'unknown command', 'text/plain');
    return;
  }
  const command = stripLine(first.lines[0]);
  const second = parsePktLines(ctx.rawBody, first.next);
  const args = second.lines.map(stripLine);
  const resultType = 'application/x-git-upload-pack-result';
  if (command === 'command=ls-refs') {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (const arg of args) {
      if (arg === 'peel') peel = true;
      else if (arg === 'symrefs') symrefs = true;
      else if (arg === 'unborn') unborn = true;
      else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    }
    const matches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => ref.startsWith(prefix));
    const parts: Buffer[] = [];
    const tip = branchTip(ctx.forge, repo, repo.defaultBranch);
    if (matches('HEAD')) {
      if (tip !== null) {
        parts.push(pktLine(`${tip} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
      } else if (unborn) {
        parts.push(pktLine(`${ZERO_OID} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
      }
    }
    const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [ref, oid] of refs) {
      if (!matches(ref)) continue;
      let line = `${oid} ${ref}`;
      if (peel) {
        const obj = ctx.forge.getObject(oid);
        if (obj?.type === 'tag') {
          const peeled = peelToCommit(ctx.forge, oid);
          if (peeled !== null) line += ` peeled:${peeled}`;
        }
      }
      parts.push(pktLine(`${line}\n`));
    }
    parts.push(FLUSH);
    sendRaw(ctx.res, 200, Buffer.concat(parts), resultType);
    return;
  }
  if (command === 'command=fetch') {
    const plan = planFetch(ctx.forge, repo, args);
    const parts: Buffer[] = [pktLine('acknowledgments\n')];
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine(plan.acks.length > 0 ? 'ready\n' : 'NAK\n'));
    parts.push(DELIM);
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(DELIM);
    }
    if (plan.pack !== null) {
      parts.push(pktLine('packfile\n'));
      for (let offset = 0; offset < plan.pack.length; offset += 32768) {
        const chunk = plan.pack.subarray(offset, Math.min(offset + 32768, plan.pack.length));
        parts.push(pktLine(Buffer.concat([Buffer.from([0x01]), chunk])));
      }
    }
    parts.push(FLUSH);
    sendRaw(ctx.res, 200, Buffer.concat(parts), resultType);
    return;
  }
  sendText(ctx.res, 400, 'unknown command', 'text/plain');
}

// ---- receive-pack v0 ---------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(ctx: RequestContext, owner: string, name: string): void {
  const repo = gitRepo(ctx, owner, name);
  if (!repo) return;
  const section = parsePktLines(ctx.rawBody, 0);
  const commands: PushCommand[] = [];
  let malformed = section.lines.length === 0;
  for (const line of section.lines) {
    const text = stripLine(line);
    const cut = text.indexOf('\0');
    const bare = cut >= 0 ? text.slice(0, cut) : text;
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(bare);
    if (!match) {
      malformed = true;
      break;
    }
    commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  if (malformed) {
    sendText(ctx.res, 400, 'malformed push', 'text/plain');
    return;
  }
  let unpackOk = true;
  let unpackDetail = '';
  const packBytes = ctx.rawBody.subarray(section.next);
  if (packBytes.length > 0) {
    try {
      readPack(ctx.forge, packBytes);
    } catch (err) {
      unpackOk = false;
      unpackDetail = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const report: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
  for (const cmd of commands) {
    if (!unpackOk) {
      report.push(`ng ${cmd.ref} unpack failed\n`);
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      if (current === undefined) report.push(`ng ${cmd.ref} reference not found\n`);
      else if (current !== cmd.oldOid) report.push(`ng ${cmd.ref} stale reference\n`);
      else {
        repo.refs.delete(cmd.ref);
        report.push(`ok ${cmd.ref}\n`);
      }
    } else if (cmd.oldOid === ZERO_OID) {
      if (!ctx.forge.hasObject(cmd.newOid)) report.push(`ng ${cmd.ref} reference not found\n`);
      else if (current !== undefined) report.push(`ng ${cmd.ref} reference already exists\n`);
      else {
        repo.refs.set(cmd.ref, cmd.newOid);
        report.push(`ok ${cmd.ref}\n`);
      }
    } else {
      if (!ctx.forge.hasObject(cmd.newOid)) {
        report.push(`ng ${cmd.ref} reference not found\n`);
      } else if (current !== cmd.oldOid) {
        report.push(`ng ${cmd.ref} stale reference\n`);
      } else {
        const oldCommit = peelToCommit(ctx.forge, cmd.oldOid);
        const newCommit = peelToCommit(ctx.forge, cmd.newOid);
        if (oldCommit !== null && newCommit !== null && oldCommit !== newCommit && !isAncestor(ctx.forge, oldCommit, newCommit)) {
          report.push(`ng ${cmd.ref} non-fast-forward\n`);
        } else {
          repo.refs.set(cmd.ref, cmd.newOid);
          report.push(`ok ${cmd.ref}\n`);
        }
      }
    }
  }
  const parts: Buffer[] = [];
  for (const line of report) parts.push(pktLine(Buffer.concat([Buffer.from([0x01]), Buffer.from(line, 'utf8')])));
  parts.push(FLUSH);
  sendRaw(ctx.res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}

// ---- server ------------------------------------------------------------------

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const rawBody = await readBody(req);
        const url = new URL(req.url ?? '/', 'http://entry');
        const pathname = url.pathname;
        const ctx: RequestContext = {
          forge,
          req,
          res,
          method: req.method ?? 'GET',
          segments: pathSegments(pathname),
          query: url.searchParams,
          host: req.headers.host ?? 'entry',
          rawBody,
          body: parseBody(rawBody),
        };
        if (ctx.method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (ctx.method === 'GET' && pathname === '/__makefun/state') {
          sendRaw(res, 200, Buffer.from(forge.exportState(), 'utf8'), 'application/json');
          return;
        }
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]);
          const name = decodeURIComponent(gitMatch[2]);
          const action = gitMatch[3];
          if (action === 'info/refs' && ctx.method === 'GET') handleInfoRefs(ctx, owner, name);
          else if (action === 'git-upload-pack' && ctx.method === 'POST') handleUploadPack(ctx, owner, name);
          else if (action === 'git-receive-pack' && ctx.method === 'POST') handleReceivePack(ctx, owner, name);
          else sendText(res, 404, 'not found', 'text/plain');
          return;
        }
        if (pathname === '/api/graphql') {
          if (ctx.method === 'POST') await handleGraphql(forge, ctx);
          else notFound(res);
          return;
        }
        if (pathname === '/mcp') {
          await handleMcp(forge, ctx);
          return;
        }
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          const restSegments = pathname === '/api/v3' ? [] : pathSegments(pathname.slice('/api/v3/'.length));
          restRoutes({ ...ctx, segments: restSegments });
          return;
        }
        notFound(res);
      } catch (err) {
        if (!res.headersSent) {
          jsonError(res, 500, `Internal error: ${err instanceof Error ? err.message : String(err)}`);
        } else {
          res.end();
        }
      }
    })();
  });
}
