// app.ts — the forge's HTTP surface: git smart HTTP (upload-pack v2, receive-pack v0), the
// GitHub REST v3 resources, and routing into the GraphQL and MCP modules. One process, one
// in-memory store (store.ts), Node stdlib only.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  ZERO_OID, commitClosure, isAncestor, mergeBase, mergeFileMaps, objectClosure, parseCommit,
  parseTree, peelToCommit, readPack, subtreeAt, writePack,
} from './gitcore.ts';
import { Forge, type IssueRec, type PullRec, type RepoRec } from './store.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const ZERO = ZERO_OID;

let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `core-forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId(), ...headers });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': requestId() });
  res.end(body);
}

function apiError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

// --------------------------------------------------------------------------- pkt-lines

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = length.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), data]);
}
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Split a pkt-line stream into payloads; returns payloads and the offset just past the flush. */
function parsePktLines(buf: Buffer, start = 0): { lines: Buffer[]; next: number; flushed: boolean } {
  const lines: Buffer[] = [];
  let pos = start;
  while (pos + 4 <= buf.length) {
    const header = buf.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-f]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) return { lines, next: pos + 4, flushed: true };
    if (length === 1) { pos += 4; return { lines, next: pos, flushed: false }; }
    if (length < 4 || pos + length > buf.length) break;
    lines.push(buf.subarray(pos + 4, pos + length));
    pos += length;
  }
  return { lines, next: pos, flushed: false };
}

/** Parse pkt-lines until a delim or flush; returns the lines and where the rest begins. */
function parsePktSection(buf: Buffer, start: number): { lines: Buffer[]; next: number; terminator: 'delim' | 'flush' | 'end' } {
  const lines: Buffer[] = [];
  let pos = start;
  while (pos + 4 <= buf.length) {
    const header = buf.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-f]{4}$/.test(header)) return { lines, next: pos, terminator: 'end' };
    const length = parseInt(header, 16);
    if (length === 0) return { lines, next: pos + 4, terminator: 'flush' };
    if (length === 1) return { lines, next: pos + 4, terminator: 'delim' };
    if (length < 4 || pos + length > buf.length) return { lines, next: pos, terminator: 'end' };
    lines.push(buf.subarray(pos + 4, pos + length));
    pos += length;
  }
  return { lines, next: pos, terminator: 'end' };
}

// --------------------------------------------------------------------------- serializers

export interface Ctx {
  forge: Forge;
  viewer: string;
}

function isoAt(forge: Forge, seq: number): string {
  // Deterministic display timestamps derived from creation order (never exported, display only).
  void forge;
  const base = Date.parse('2026-01-01T00:00:00Z');
  return new Date(base + seq * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function serializeRepo(forge: Forge, repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: forge.globalId('repo', repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: { login: repo.owner, id: forge.users.get(repo.owner)?.id ?? 0, type: 'User' },
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://forge.local/${repo.owner}/${repo.name}`,
    created_at: isoAt(forge, repo.createdSeq),
    updated_at: isoAt(forge, repo.createdSeq),
  };
}

export function serializeIssue(forge: Forge, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + issue.number,
    node_id: forge.globalId('issue', repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? '000000' })),
    user: { login: forge.viewer.login, id: forge.viewer.id, type: 'User' },
    comments: issue.comments.length,
    created_at: isoAt(forge, issue.createdSeq),
    updated_at: isoAt(forge, issue.createdSeq),
    html_url: `https://forge.local/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function serializeComment(forge: Forge, repo: RepoRec, issue: IssueRec, comment: { id: number; body: string; createdSeq: number }): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + issue.number * 1000 + comment.id,
    node_id: forge.globalId('comment', repo, issue.number, comment.id),
    body: comment.body,
    user: { login: forge.viewer.login, id: forge.viewer.id, type: 'User' },
    created_at: isoAt(forge, comment.createdSeq),
    updated_at: isoAt(forge, comment.createdSeq),
    html_url: `https://forge.local/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
  };
}

function currentSha(forge: Forge, repo: RepoRec, branch: string, fallback: string): string {
  return forge.refCommit(repo, `refs/heads/${branch}`) ?? fallback;
}

export function serializePull(forge: Forge, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + pull.number,
    node_id: forge.globalId('pull', repo, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      ref: pull.headRef,
      sha: currentSha(forge, repo, pull.headRef, pull.createdHeadSha),
      label: `${repo.owner}:${pull.headRef}`,
    },
    base: {
      ref: pull.baseRef,
      sha: currentSha(forge, repo, pull.baseRef, pull.createdBaseSha),
      label: `${repo.owner}:${pull.baseRef}`,
    },
    user: { login: forge.viewer.login, id: forge.viewer.id, type: 'User' },
    created_at: isoAt(forge, pull.createdSeq),
    updated_at: isoAt(forge, pull.createdSeq),
    html_url: `https://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

// --------------------------------------------------------------------------- pull merge & diff (shared with GraphQL/MCP)

/** Squash-merge a pull request into its base branch. Returns the merge commit oid, or null on conflict. */
export function mergePullRequest(forge: Forge, repo: RepoRec, pull: PullRec): string | null {
  const store = forge.store;
  const baseTip = forge.refCommit(repo, `refs/heads/${pull.baseRef}`);
  const headTip = forge.refCommit(repo, `refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return null;
  const base = mergeBase(store, baseTip, headTip);
  if (!base) return null;
  const conflicts: string[] = [];
  const merged = mergeFileMaps(forge.filesAt(base), forge.filesAt(baseTip), forge.filesAt(headTip), conflicts);
  if (!merged) return null;
  const message = `${pull.title} (#${pull.number})${pull.body ? `\n\n${pull.body}` : ''}`;
  const commit = forge.commitFiles(repo, merged, baseTip, message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.nowIso();
  pull.mergeCommitSha = commit;
  return commit;
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  patch: string;
}

/** Line-level diff counts via LCS on lines (files in the suite are small; capped for safety). */
function diffLines(a: string[], b: string[]): { additions: number; deletions: number; patch: string } {
  if (a.length > 4000 || b.length > 4000) {
    return { additions: b.length, deletions: a.length, patch: `@@ -1,${a.length} +1,${b.length} @@` };
  }
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const patchLines: string[] = [`@@ -1,${a.length} +1,${b.length} @@`];
  let additions = 0;
  let deletions = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { patchLines.push(`-${a[i]}`); deletions += 1; i += 1; }
    else { patchLines.push(`+${b[j]}`); additions += 1; j += 1; }
  }
  while (i < a.length) { patchLines.push(`-${a[i]}`); deletions += 1; i += 1; }
  while (j < b.length) { patchLines.push(`+${b[j]}`); additions += 1; j += 1; }
  return { additions, deletions, patch: patchLines.join('\n') };
}

export function pullFiles(forge: Forge, repo: RepoRec, pull: PullRec): FileDiff[] {
  const store = forge.store;
  const baseTip = forge.refCommit(repo, `refs/heads/${pull.baseRef}`) ?? pull.createdBaseSha;
  const headTip = forge.refCommit(repo, `refs/heads/${pull.headRef}`) ?? pull.createdHeadSha;
  const base = mergeBase(store, baseTip, headTip) ?? baseTip;
  const baseFiles = forge.filesAt(base);
  const headFiles = forge.filesAt(headTip);
  const out: FileDiff[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const from = baseFiles.get(path);
    const to = headFiles.get(path);
    if (from?.oid === to?.oid && from?.mode === to?.mode) continue;
    const aText = from ? (store.get(from.oid)?.data.toString('utf8') ?? '') : '';
    const bText = to ? (store.get(to.oid)?.data.toString('utf8') ?? '') : '';
    const aLines = aText === '' ? [] : aText.split('\n');
    const bLines = bText === '' ? [] : bText.split('\n');
    const diff = diffLines(aLines, bLines);
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

/** Whether a pull's head still merges cleanly into the current base tip (GraphQL mergeable). */
export function pullMergeable(forge: Forge, repo: RepoRec, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state === 'closed') return 'UNKNOWN';
  const baseTip = forge.refCommit(repo, `refs/heads/${pull.baseRef}`);
  const headTip = forge.refCommit(repo, `refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return 'UNKNOWN';
  const base = mergeBase(forge.store, baseTip, headTip);
  if (!base) return 'CONFLICTING';
  const conflicts: string[] = [];
  const merged = mergeFileMaps(forge.filesAt(base), forge.filesAt(baseTip), forge.filesAt(headTip), conflicts);
  return merged ? 'MERGEABLE' : 'CONFLICTING';
}

// --------------------------------------------------------------------------- HTTP plumbing

export interface RequestData {
  method: string;
  segments: string[];
  query: URLSearchParams;
  host: string;
  authed: boolean;
  body: Buffer;
  json: Record<string, unknown> | null;
  jsonArray: unknown[] | null;
  jsonMalformed: boolean;
  protocolHeader: string;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 128 * 1024 * 1024) { reject(new Error('body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function hasAuth(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || header.trim() === '') return false;
  const value = header.replace(/^(Bearer|token)\s+/i, '').trim();
  return value !== '';
}

// --------------------------------------------------------------------------- REST

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page')) || 30));
  const page = Math.max(1, Number(query.get('page')) || 1);
  return { perPage, page };
}

function paginate<T>(res: ServerResponse, req: RequestData, items: T[], basePath: string): T[] {
  const { perPage, page } = pageParams(req.query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const links: string[] = [];
  const url = (p: number) => `http://${req.host}${basePath}?per_page=${perPage}&page=${p}`;
  if (page < totalPages) links.push(`<${url(page + 1)}>; rel="next"`, `<${url(totalPages)}>; rel="last"`);
  if (page > 1) links.push(`<${url(page - 1)}>; rel="prev"`, `<${url(1)}>; rel="first"`);
  if (links.length > 0) res.setHeader('link', links.join(', '));
  return items.slice((page - 1) * perPage, page * perPage);
}

function restRoutes(ctx: Ctx, req: RequestData, res: ServerResponse): boolean {
  const { forge } = ctx;
  const seg = req.segments;
  if (seg[0] !== 'api' || seg[1] !== 'v3') return false;
  const rest = seg.slice(2);
  const method = req.method;

  // API root + meta (the starter's two answers, kept in shape).
  if (rest.length === 0) {
    if (method !== 'GET') { apiError(res, 404, 'Not Found'); return true; }
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') { apiError(res, 404, 'Not Found'); return true; }
    sendJson(res, 200, { installed_version: '1.0.0-core-forge', verifiable_password_authentication: false });
    return true;
  }

  if (!req.authed) { apiError(res, 401, 'Requires authentication'); return true; }
  if (req.jsonMalformed) { apiError(res, 400, 'Problems parsing JSON'); return true; }
  const body = req.json ?? {};
  const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
  const viewer = forge.viewer.login;

  // /user and /user/repos
  if (rest[0] === 'user' && rest.length === 1) {
    if (method !== 'GET') { apiError(res, 404, 'Not Found'); return true; }
    sendJson(res, 200, { login: viewer, id: forge.viewer.id, name: forge.viewer.name, type: 'User', node_id: Buffer.from(`user:${forge.viewer.id}`).toString('base64') });
    return true;
  }
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const mine = forge.reposOf(viewer).map((repo) => serializeRepo(forge, repo));
      sendJson(res, 200, paginate(res, req, mine, '/api/v3/user/repos'));
      return true;
    }
    if (method === 'POST') {
      const name = str(body.name);
      if (!name) { apiError(res, 422, 'Validation Failed: name is required'); return true; }
      if (forge.getRepo(viewer, name)) {
        sendJson(res, 422, {
          message: 'Validation Failed: name already exists on this account',
          errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
        });
        return true;
      }
      const repo = forge.createRepo(viewer, name, { description: str(body.description) ?? '', isPrivate: body.private === true });
      sendJson(res, 201, serializeRepo(forge, repo));
      return true;
    }
    apiError(res, 404, 'Not Found');
    return true;
  }

  if (rest[0] !== 'repos' || rest.length < 3) { apiError(res, 404, 'Not Found'); return true; }
  const owner = rest[1];
  const repoName = rest[2];
  const repo = forge.getRepo(owner, repoName);
  if (!repo) { apiError(res, 404, 'Not Found'); return true; }
  const tail = rest.slice(3);
  const repoPath = `/api/v3/repos/${owner}/${repoName}`;

  // The repository itself.
  if (tail.length === 0) {
    if (method === 'GET') { sendJson(res, 200, serializeRepo(forge, repo)); return true; }
    if (method === 'PATCH') {
      if (str(body.description) !== undefined) repo.description = str(body.description)!;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      sendJson(res, 200, serializeRepo(forge, repo));
      return true;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      res.writeHead(204, { 'x-github-request-id': requestId() });
      res.end();
      return true;
    }
    apiError(res, 404, 'Not Found');
    return true;
  }

  // Branches.
  if (tail[0] === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: peelToCommit(forge.store, oid) ?? oid }, protected: false }));
      sendJson(res, 200, branches);
      return true;
    }
    if (tail.length >= 2 && method === 'GET') {
      const branch = tail.slice(1).join('/');
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (!oid) { apiError(res, 404, 'Not Found'); return true; }
      sendJson(res, 200, { name: branch, commit: { sha: peelToCommit(forge.store, oid) ?? oid }, protected: false });
      return true;
    }
    apiError(res, 404, 'Not Found');
    return true;
  }

  // Git refs.
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (tail.length === 2 && method === 'GET') {
      const refs = [...repo.refs.entries()].map(([ref, oid]) => ({ ref, object: { sha: oid, type: forge.store.get(oid)?.type ?? 'commit' } }));
      sendJson(res, 200, refs);
      return true;
    }
    if (tail.length === 2 && method === 'POST') {
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (!ref || !ref.startsWith('refs/') || !sha || !forge.store.has(sha)) { apiError(res, 422, 'Validation Failed: invalid ref or sha'); return true; }
      if (repo.refs.has(ref)) { apiError(res, 422, 'Validation Failed: Reference already exists'); return true; }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: forge.store.get(sha)?.type ?? 'commit' } });
      return true;
    }
    if (tail.length >= 3 && method === 'GET') {
      const ref = `refs/${tail.slice(2).join('/')}`;
      const oid = repo.refs.get(ref);
      if (!oid) { apiError(res, 404, 'Not Found'); return true; }
      sendJson(res, 200, { ref, object: { sha: oid, type: forge.store.get(oid)?.type ?? 'commit' } });
      return true;
    }
    apiError(res, 404, 'Not Found');
    return true;
  }

  // Commit list.
  if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
    const shaParam = req.query.get('sha');
    let start: string | null = null;
    if (!shaParam) start = forge.defaultTip(repo);
    else if (repo.refs.has(`refs/heads/${shaParam}`)) start = forge.refCommit(repo, `refs/heads/${shaParam}`);
    else if (repo.refs.has(shaParam)) start = forge.refCommit(repo, shaParam);
    else if (forge.store.get(shaParam)?.type === 'commit') start = shaParam;
    else if (forge.store.has(shaParam)) start = peelToCommit(forge.store, shaParam);
    if (!start) { sendJson(res, 200, []); return true; }
    const order: string[] = [];
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      order.push(oid);
      const obj = forge.store.get(oid);
      if (obj?.type === 'commit') queue.push(...parseCommit(obj.data).parents);
    }
    const commits = order.map((oid) => {
      const raw = forge.store.get(oid)!.data;
      const parsed = parseCommit(raw);
      const authorLine = /^author (.*)$/m.exec(raw.toString('utf8'))?.[1] ?? '';
      const authorMatch = /^(.*?) <(.*?)> (\d+) /.exec(authorLine);
      const when = authorMatch ? new Date(Number(authorMatch[3]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : isoAt(forge, repo.createdSeq);
      return {
        sha: oid,
        commit: {
          message: parsed.message.replace(/\n$/, ''),
          tree: { sha: parsed.tree },
          author: { name: authorMatch?.[1] ?? '', email: authorMatch?.[2] ?? '', date: when },
          committer: { name: authorMatch?.[1] ?? '', email: authorMatch?.[2] ?? '', date: when },
        },
        parents: parsed.parents.map((parent) => ({ sha: parent })),
      };
    });
    sendJson(res, 200, paginate(res, req, commits, `${repoPath}/commits`));
    return true;
  }

  // Contents.
  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    return contentsRoute(ctx, req, res, repo, path);
  }

  // Labels.
  if (tail[0] === 'labels' && tail.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
      return true;
    }
    if (method === 'POST') {
      const name = str(body.name);
      if (!name) { apiError(res, 422, 'Validation Failed: name is required'); return true; }
      if (repo.labels.has(name)) { apiError(res, 422, 'Validation Failed: Label already exists'); return true; }
      const label = { name, color: (str(body.color) ?? '000000').replace(/^#/, '') };
      repo.labels.set(name, label);
      sendJson(res, 201, { name: label.name, color: label.color });
      return true;
    }
    apiError(res, 404, 'Not Found');
    return true;
  }

  // Issues.
  if (tail[0] === 'issues') {
    return issuesRoute(ctx, req, res, repo, tail.slice(1), repoPath);
  }

  // Pull requests.
  if (tail[0] === 'pulls') {
    return pullsRoute(ctx, req, res, repo, tail.slice(1));
  }

  apiError(res, 404, 'Not Found');
  return true;
}

function resolveRefCommit(forge: Forge, repo: RepoRec, ref: string | undefined): string | null {
  if (!ref) return forge.defaultTip(repo);
  if (repo.refs.has(`refs/heads/${ref}`)) return forge.refCommit(repo, `refs/heads/${ref}`);
  if (repo.refs.has(ref)) return forge.refCommit(repo, ref);
  if (forge.store.has(ref)) return peelToCommit(forge.store, ref);
  return null;
}

function contentsRoute(ctx: Ctx, req: RequestData, res: ServerResponse, repo: RepoRec, path: string): boolean {
  const { forge } = ctx;
  const method = req.method;
  const body = req.json ?? {};
  const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

  if (method === 'GET') {
    const commit = resolveRefCommit(forge, repo, req.query.get('ref') ?? undefined);
    if (!commit) { apiError(res, 404, 'Not Found'); return true; }
    const files = forge.filesAt(commit);
    const file = files.get(path);
    if (file) {
      const blob = forge.store.get(file.oid);
      sendJson(res, 200, {
        type: 'file',
        name: path.split('/').pop(),
        path,
        sha: file.oid,
        size: blob?.data.length ?? 0,
        encoding: 'base64',
        content: (blob?.data ?? Buffer.alloc(0)).toString('base64'),
      });
      return true;
    }
    // Directory listing: the children of `path` (or the root).
    const tree = parseCommit(forge.store.get(commit)!.data).tree;
    const sub = subtreeAt(forge.store, tree, path);
    if (sub === null) { apiError(res, 404, 'Not Found'); return true; }
    const entries = parseTree(forge.store.get(sub)!.data)
      .map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: path === '' ? entry.name : `${path}/${entry.name}`,
        sha: entry.oid,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    sendJson(res, 200, entries);
    return true;
  }

  if (method === 'PUT') {
    const message = str(body.message);
    const contentB64 = str(body.content);
    if (message === undefined || contentB64 === undefined) { apiError(res, 422, 'Validation Failed: message and content are required'); return true; }
    const branch = str(body.branch) ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const tip = forge.refCommit(repo, ref);
    const files = forge.filesAt(tip);
    const existing = files.get(path);
    if (existing) {
      const givenSha = str(body.sha);
      if (givenSha === undefined) { apiError(res, 422, 'Validation Failed: sha is required when updating a file'); return true; }
      if (givenSha !== existing.oid) { apiError(res, 409, 'Conflict: sha does not match the current file'); return true; }
    }
    const data = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
    const blobOid = forge.store.put('blob', data);
    files.set(path, { mode: '100644', oid: blobOid });
    const commit = forge.commitFiles(repo, files, tip, message);
    repo.refs.set(ref, commit);
    sendJson(res, existing ? 200 : 201, {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: data.length, type: 'file', encoding: 'base64' },
      commit: { sha: commit, message },
    });
    return true;
  }

  if (method === 'DELETE') {
    const message = str(body.message);
    const sha = str(body.sha);
    if (message === undefined || sha === undefined) { apiError(res, 422, 'Validation Failed: message and sha are required'); return true; }
    const branch = str(body.branch) ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const tip = forge.refCommit(repo, ref);
    const files = forge.filesAt(tip);
    const existing = files.get(path);
    if (!existing) { apiError(res, 404, 'Not Found'); return true; }
    if (sha !== existing.oid) { apiError(res, 409, 'Conflict: sha does not match the current file'); return true; }
    files.delete(path);
    const commit = forge.commitFiles(repo, files, tip, message);
    repo.refs.set(ref, commit);
    sendJson(res, 200, { content: null, commit: { sha: commit, message } });
    return true;
  }

  apiError(res, 404, 'Not Found');
  return true;
}

function issuesRoute(ctx: Ctx, req: RequestData, res: ServerResponse, repo: RepoRec, tail: string[], repoPath: string): boolean {
  const { forge } = ctx;
  const method = req.method;
  const body = req.json ?? {};
  const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

  if (tail.length === 0) {
    if (method === 'POST') {
      const title = str(body.title);
      if (!title) { apiError(res, 422, 'Validation Failed: title is required'); return true; }
      const labelNames = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [];
      const unknown = labelNames.filter((name) => !repo.labels.has(name));
      if (unknown.length > 0) { apiError(res, 422, `Validation Failed: unknown label ${unknown.join(', ')}`); return true; }
      const issue = forge.createIssue(repo, { title, body: str(body.body) ?? '', labels: labelNames });
      sendJson(res, 201, serializeIssue(forge, repo, issue));
      return true;
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const direction = req.query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      if (direction !== 'asc') list.reverse();
      const serialized = list.map((issue) => serializeIssue(forge, repo, issue));
      sendJson(res, 200, paginate(res, req, serialized, `${repoPath}/issues`));
      return true;
    }
    apiError(res, 404, 'Not Found');
    return true;
  }

  const number = Number(tail[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (!issue) { apiError(res, 404, 'Not Found'); return true; }

  if (tail.length === 1) {
    if (method === 'GET') { sendJson(res, 200, serializeIssue(forge, repo, issue)); return true; }
    if (method === 'PATCH') {
      if (str(body.title) !== undefined) issue.title = str(body.title)!;
      if (str(body.body) !== undefined) issue.body = str(body.body)!;
      if (str(body.state) === 'closed' || str(body.state) === 'open') issue.state = str(body.state) as 'open' | 'closed';
      if (Array.isArray(body.labels)) {
        const names = body.labels.filter((x): x is string => typeof x === 'string');
        const unknown = names.filter((name) => !repo.labels.has(name));
        if (unknown.length > 0) { apiError(res, 422, `Validation Failed: unknown label ${unknown.join(', ')}`); return true; }
        issue.labels = names;
      }
      sendJson(res, 200, serializeIssue(forge, repo, issue));
      return true;
    }
    apiError(res, 404, 'Not Found');
    return true;
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'POST') {
      const text = str(body.body);
      if (text === undefined) { apiError(res, 422, 'Validation Failed: body is required'); return true; }
      const comment = { id: issue.nextCommentId, body: text, createdSeq: forge.nextSeq() };
      issue.nextCommentId += 1;
      issue.comments.push(comment);
      sendJson(res, 201, serializeComment(forge, repo, issue, comment));
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((comment) => serializeComment(forge, repo, issue, comment)));
      return true;
    }
  }

  apiError(res, 404, 'Not Found');
  return true;
}

function pullsRoute(ctx: Ctx, req: RequestData, res: ServerResponse, repo: RepoRec, tail: string[]): boolean {
  const { forge } = ctx;
  const method = req.method;
  const body = req.json ?? {};
  const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
  const stripOwner = (ref: string) => (ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref);

  if (tail.length === 0) {
    if (method === 'POST') {
      const headRaw = str(body.head);
      const baseRaw = str(body.base);
      const title = str(body.title);
      if (!headRaw || !baseRaw || title === undefined) { apiError(res, 422, 'Validation Failed: head, base and title are required'); return true; }
      const head = stripOwner(headRaw);
      const base = stripOwner(baseRaw);
      const headSha = forge.refCommit(repo, `refs/heads/${head}`);
      const baseSha = forge.refCommit(repo, `refs/heads/${base}`);
      if (!headSha) { apiError(res, 422, 'Validation Failed: head is invalid'); return true; }
      if (!baseSha) { apiError(res, 422, 'Validation Failed: base is invalid'); return true; }
      const pull = forge.createPull(repo, { title, body: str(body.body) ?? '', headRef: head, baseRef: base, headSha, baseSha });
      sendJson(res, 201, serializePull(forge, repo, pull));
      return true;
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      sendJson(res, 200, list.map((pull) => serializePull(forge, repo, pull)));
      return true;
    }
    apiError(res, 404, 'Not Found');
    return true;
  }

  const number = Number(tail[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (!pull) { apiError(res, 404, 'Not Found'); return true; }

  if (tail.length === 1) {
    if (method === 'GET') { sendJson(res, 200, serializePull(forge, repo, pull)); return true; }
    if (method === 'PATCH') {
      if (str(body.state) === 'closed' || str(body.state) === 'open') pull.state = str(body.state) as 'open' | 'closed';
      if (str(body.title) !== undefined) pull.title = str(body.title)!;
      if (str(body.body) !== undefined) pull.body = str(body.body)!;
      sendJson(res, 200, serializePull(forge, repo, pull));
      return true;
    }
    apiError(res, 404, 'Not Found');
    return true;
  }

  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    sendJson(res, 200, pullFiles(forge, repo, pull));
    return true;
  }

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (pull.merged || pull.state === 'closed') { apiError(res, 405, 'Pull Request is not mergeable: already closed or merged'); return true; }
    const sha = mergePullRequest(forge, repo, pull);
    if (!sha) { apiError(res, 405, 'Pull Request is not mergeable: merge conflict'); return true; }
    sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
    return true;
  }

  apiError(res, 404, 'Not Found');
  return true;
}

// --------------------------------------------------------------------------- git transport

const AGENT = 'core-forge/1.0';

function sortedRefs(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}

/** The v0 ref advertisement lines (used by receive-pack, and as upload-pack's v0 answer). */
function v0Advertisement(forge: Forge, repo: RepoRec, capabilities: string): Buffer {
  const parts: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  const first = headTip ? `${headTip} HEAD` : `${ZERO} capabilities^{}`;
  parts.push(pktLine(`${first}\0${capabilities}\n`));
  for (const [ref, oid] of sortedRefs(repo)) {
    parts.push(pktLine(`${oid} ${ref}\n`));
    const obj = forge.store.get(oid);
    if (obj?.type === 'tag') {
      const commit = peelToCommit(forge.store, oid);
      if (commit) parts.push(pktLine(`${commit} ${ref}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function gitInfoRefs(ctx: Ctx, req: RequestData, res: ServerResponse, repo: RepoRec | undefined, service: string | null): void {
  if (!repo) { sendRaw(res, 404, Buffer.from('not found'), 'text/plain'); return; }
  if (!req.authed) { sendRaw(res, 401, Buffer.from('unauthorized'), 'text/plain'); return; }
  const { forge } = ctx;
  if (service === 'git-upload-pack') {
    if (req.protocolHeader.includes('version=2')) {
      const lines = [
        'version 2',
        `agent=${AGENT}`,
        'ls-refs=unborn',
        'fetch=shallow',
        'object-format=sha1',
      ];
      const body = Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
      sendRaw(res, 200, body, 'application/x-git-upload-pack-advertisement');
      return;
    }
    const preamble = pktLine('# service=git-upload-pack\n');
    const advertisement = v0Advertisement(forge, repo, `multi_ack_detailed side-band-64k ofs-delta agent=${AGENT}`);
    sendRaw(res, 200, Buffer.concat([preamble, PKT_FLUSH, advertisement]), 'application/x-git-upload-pack-advertisement');
    return;
  }
  if (service === 'git-receive-pack') {
    const preamble = pktLine('# service=git-receive-pack\n');
    const capabilities = `report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
    const advertisement = v0Advertisement(forge, repo, capabilities);
    sendRaw(res, 200, Buffer.concat([preamble, PKT_FLUSH, advertisement]), 'application/x-git-receive-pack-advertisement');
    return;
  }
  sendRaw(res, 400, Buffer.from('unknown service'), 'text/plain');
}

function lsRefsAnswer(forge: Forge, repo: RepoRec, args: string[]): Buffer {
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
  const matches = (name: string) => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headTip) {
      lines.push(`${headTip} HEAD${symrefs ? ` symref-target:${headRef}` : ''}`);
    } else if (unborn) {
      lines.push(`${ZERO} HEAD${symrefs ? ` symref-target:${headRef}` : ''}`);
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const obj = forge.store.get(oid);
      if (obj?.type === 'tag') {
        const commit = peelToCommit(forge.store, oid);
        if (commit) line += ` peeled:${commit}`;
      }
    }
    lines.push(line);
  }
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
}

interface FetchPlan {
  pack: Buffer | null;
  shallow: string[];
  unshallow: string[];
  acks: string[];
  anyAck: boolean;
}

/** Pack cache: the bench clones the same tip many times concurrently; a pack is a pure function
 *  of the repo's ref tips plus the request's wants/haves/deepen/shallow, so key on all of them. */
const packCache = new Map<string, Buffer>();

function planFetch(forge: Forge, repo: RepoRec, args: string[]): FetchPlan {
  const store = forge.store;
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow = new Set<string>();
  let deepen: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) clientShallow.add(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) deepen = Number(arg.slice(7).trim());
  }
  const acks = haves.filter((oid) => store.get(oid)?.type === 'commit');
  const held = commitClosure(store, haves, clientShallow);
  // Wants may name tag objects (an annotated tag clone): walk the graph from their commits,
  // and remember the tag chain so the tag objects themselves ride along in the pack.
  const tagChain: string[] = [];
  const commitWants: string[] = [];
  for (const oid of wants) {
    let current = oid;
    for (let hops = 0; hops < 16; hops += 1) {
      const obj = store.get(current);
      if (!obj) break;
      if (obj.type === 'commit') { commitWants.push(current); break; }
      if (obj.type === 'tag') {
        tagChain.push(current);
        const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
        if (!match) break;
        current = match[1];
        continue;
      }
      break;
    }
  }

  let sendCommits: Set<string>;
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (deepen !== null && Number.isFinite(deepen) && deepen > 0) {
    // BFS from the wants, assigning generations; traversal stops at the deepen horizon.
    const distance = new Map<string, number>();
    let frontier = commitWants.filter((oid) => store.get(oid)?.type === 'commit');
    for (const oid of frontier) distance.set(oid, 1);
    let depth = 1;
    while (frontier.length > 0 && depth < deepen) {
      const next: string[] = [];
      for (const oid of frontier) {
        for (const parent of parseCommit(store.get(oid)!.data).parents) {
          if (!distance.has(parent) && store.get(parent)?.type === 'commit') {
            distance.set(parent, depth + 1);
            next.push(parent);
          }
        }
      }
      frontier = next;
      depth += 1;
    }
    const considered = new Set(distance.keys());
    sendCommits = new Set([...considered].filter((oid) => !held.has(oid)));
    for (const oid of sendCommits) {
      if (distance.get(oid) === deepen) {
        const parents = parseCommit(store.get(oid)!.data).parents;
        if (parents.length > 0 && !clientShallow.has(oid)) shallow.push(oid);
      }
    }
    for (const oid of clientShallow) {
      if (!considered.has(oid)) continue;
      const obj = store.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parentsIncluded = parseCommit(obj.data).parents.every((parent) => considered.has(parent) || held.has(parent));
      if (parentsIncluded && !shallow.includes(oid)) unshallow.push(oid);
    }
  } else {
    const wanted = commitClosure(store, commitWants);
    sendCommits = new Set([...wanted].filter((oid) => !held.has(oid)));
  }

  let pack: Buffer | null = null;
  if (sendCommits.size > 0) {
    const cacheKey = [
      [...repo.refs.entries()].sort().map(([ref, oid]) => `${ref}=${oid}`).join(','),
      [...sendCommits].sort().join(','),
      [...held].sort().join(','),
      tagChain.join(','),
    ].join('|');
    pack = packCache.get(cacheKey) ?? null;
    if (!pack) {
      const objects = objectClosure(store, sendCommits, held);
      for (const tag of tagChain) {
        const commit = peelToCommit(store, tag);
        if (commit && sendCommits.has(commit)) objects.add(tag);
      }
      const commitList = [...sendCommits];
      const rest = [...objects].filter((oid) => !sendCommits.has(oid)).sort();
      pack = writePack(store, [...commitList, ...rest]);
      if (packCache.size > 64) packCache.clear();
      packCache.set(cacheKey, pack);
    }
  }
  return { pack, shallow, unshallow, acks, anyAck: acks.length > 0 };
}

function gitUploadPack(ctx: Ctx, req: RequestData, res: ServerResponse, repo: RepoRec | undefined): void {
  if (!repo) { sendRaw(res, 404, Buffer.from('not found'), 'text/plain'); return; }
  if (!req.authed) { sendRaw(res, 401, Buffer.from('unauthorized'), 'text/plain'); return; }
  const { forge } = ctx;
  const first = parsePktSection(req.body, 0);
  const commandLine = first.lines[0]?.toString('utf8').trim() ?? '';
  const argsSection = parsePktSection(req.body, first.next);
  const args = argsSection.lines.map((line) => line.toString('utf8').replace(/\n$/, ''));

  if (commandLine === 'command=ls-refs') {
    sendRaw(res, 200, lsRefsAnswer(forge, repo, args), 'application/x-git-upload-pack-result');
    return;
  }
  if (commandLine === 'command=fetch') {
    const plan = planFetch(forge, repo, args);
    const parts: Buffer[] = [];
    parts.push(pktLine('acknowledgments\n'));
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine(plan.anyAck ? 'ready\n' : 'NAK\n'));
    parts.push(PKT_DELIM);
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    if (plan.pack) {
      parts.push(pktLine('packfile\n'));
      const pack = plan.pack;
      for (let offset = 0; offset < pack.length; offset += 32768) {
        const chunk = pack.subarray(offset, Math.min(pack.length, offset + 32768));
        parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
      }
    }
    parts.push(PKT_FLUSH);
    sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }
  sendRaw(res, 400, Buffer.from('unknown command'), 'text/plain');
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function gitReceivePack(ctx: Ctx, req: RequestData, res: ServerResponse, repo: RepoRec | undefined): void {
  if (!repo) { sendRaw(res, 404, Buffer.from('not found'), 'text/plain'); return; }
  if (!req.authed) { sendRaw(res, 401, Buffer.from('unauthorized'), 'text/plain'); return; }
  const { forge } = ctx;
  const store = forge.store;
  const parsed = parsePktLines(req.body, 0);
  const commands: PushCommand[] = [];
  let malformed = parsed.lines.length === 0;
  for (const rawLine of parsed.lines) {
    let line = rawLine.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) line = line.slice(0, nul);
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (!match) { malformed = true; break; }
    commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  if (malformed) {
    sendRaw(res, 400, Buffer.from('malformed push'), 'text/plain');
    return;
  }
  const packBytes = req.body.subarray(parsed.next);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      readPack(store, packBytes);
    } catch (err) {
      unpackOk = false;
      unpackDetail = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  for (const command of commands) {
    const fail = (reason: string) => results.push({ ref: command.ref, ok: false, reason });
    if (!unpackOk) { fail('unpack failed'); continue; }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO) {
      if (current === undefined) { fail('reference not found'); continue; }
      if (current !== command.oldOid) { fail('stale reference'); continue; }
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true });
      continue;
    }
    const newObj = store.get(command.newOid);
    if (!newObj) { fail('reference not found'); continue; }
    if (command.oldOid === ZERO) {
      if (current !== undefined) { fail('reference already exists'); continue; }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true });
      continue;
    }
    if (current !== command.oldOid) { fail('stale reference'); continue; }
    const oldCommit = peelToCommit(store, command.oldOid);
    const newCommit = peelToCommit(store, command.newOid);
    if (oldCommit && newCommit && oldCommit !== newCommit && !isAncestor(store, oldCommit, newCommit)) {
      fail('non-fast-forward');
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true });
  }

  const report: Buffer[] = [];
  report.push(pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`));
  for (const result of results) {
    report.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`));
  }
  report.push(PKT_FLUSH);
  const wrapped = report.map((packet) => pktLine(Buffer.concat([Buffer.from([1]), packet])));
  sendRaw(res, 200, Buffer.concat([...wrapped, PKT_FLUSH]), 'application/x-git-receive-pack-result');
}

// --------------------------------------------------------------------------- the server

export function createApp(): Server {
  const forge = new Forge();
  const ctx: Ctx = { forge, viewer: forge.viewer.login };
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const pathname = url.pathname;
        const body = await readBody(req);
        let json: Record<string, unknown> | null = null;
        let jsonArray: unknown[] | null = null;
        let jsonMalformed = false;
        if (body.length > 0) {
          try {
            const parsedBody: unknown = JSON.parse(body.toString('utf8'));
            if (Array.isArray(parsedBody)) jsonArray = parsedBody;
            else if (parsedBody !== null && typeof parsedBody === 'object') json = parsedBody as Record<string, unknown>;
          } catch {
            jsonMalformed = true;
          }
        }
        const segments = pathname.split('/').filter((s) => s !== '').map((s) => {
          try { return decodeURIComponent(s); } catch { return s; }
        });
        const data: RequestData = {
          method: req.method ?? 'GET',
          segments,
          query: url.searchParams,
          host: req.headers.host ?? 'entry',
          authed: hasAuth(req),
          body,
          json,
          jsonArray,
          jsonMalformed,
          protocolHeader: typeof req.headers['git-protocol'] === 'string' ? req.headers['git-protocol'] : '',
        };

        if (data.method === 'GET' && pathname === '/healthz') { sendJson(res, 200, { ok: true }); return; }
        if (data.method === 'GET' && pathname === '/__makefun/state') { sendRaw(res, 200, Buffer.from(forge.exportState()), 'application/json'); return; }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]);
          const repoName = decodeURIComponent(gitMatch[2]);
          const repo = forge.getRepo(owner, repoName);
          const kind = gitMatch[3];
          if (kind === 'info/refs' && data.method === 'GET') { gitInfoRefs(ctx, data, res, repo, url.searchParams.get('service')); return; }
          if (kind === 'git-upload-pack' && data.method === 'POST') { gitUploadPack(ctx, data, res, repo); return; }
          if (kind === 'git-receive-pack' && data.method === 'POST') { gitReceivePack(ctx, data, res, repo); return; }
          sendRaw(res, 404, Buffer.from('not found'), 'text/plain');
          return;
        }

        if (pathname === '/api/graphql') {
          await handleGraphQL(ctx, data, res, sendJson);
          return;
        }
        if (pathname === '/mcp') {
          await handleMcp(ctx, data, res, sendJson);
          return;
        }

        if (restRoutes(ctx, data, res)) return;
        apiError(res, 404, 'Not Found');
      } catch (err) {
        try {
          if (!res.headersSent) apiError(res, 500, `Internal error: ${err instanceof Error ? err.message : String(err)}`);
          else res.end();
        } catch { /* socket already gone */ }
      }
    })();
  });
}
