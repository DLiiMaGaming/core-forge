// mcp.ts — the Model Context Protocol endpoint (POST /mcp): JSON-RPC 2.0 over the
// streamable HTTP transport, answered as plain application/json. It speaks the
// 2026-07-28 revision (server/discover) and the classic handshake revisions
// (initialize + notifications/initialized). The six tools act on the same store
// the REST surface serves, through the same create/merge code paths, so an
// object made over MCP reads back over /api/v3 unchanged.

import type { ServerResponse } from 'node:http';
import type { Ctx, RequestData } from './app.ts';
import { mergePullRequest, serializeIssue, serializePull, serializeRepo } from './app.ts';
import type { RepoRec } from './store.ts';

type SendJson = (res: ServerResponse, status: number, body: unknown) => void;

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'core-forge', version: '1.0.0' };

// --------------------------------------------------------------------------- tool catalogue
// Built once, in a fixed key order, so two tools/list calls answer byte for byte
// the same list.

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, additionalProperties: true, required };
}

const OWNER_REPO_PROPS: Record<string, unknown> = {
  owner: { type: 'string', description: 'The repository owner login.' },
  repo: { type: 'string', description: 'The repository name.' },
  full_name: { type: 'string', description: 'The repository full name, as owner/repo.' },
};

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user and return the repository object.',
    inputSchema: objectSchema({
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    }, ['name']),
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name and return the repository object.',
    inputSchema: objectSchema({ ...OWNER_REPO_PROPS }, ['owner', 'repo']),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository and return the issue object.',
    inputSchema: objectSchema({
      ...OWNER_REPO_PROPS,
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body text.' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Label names to attach; each label must already exist on the repository.' },
    }, ['owner', 'repo', 'title']),
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, newest first, optionally filtered by state (open, closed or all).',
    inputSchema: objectSchema({
      ...OWNER_REPO_PROPS,
      state: { type: 'string', description: 'Filter by issue state: open, closed or all. Defaults to open.' },
    }, ['owner', 'repo']),
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch to a base branch in a repository and return the pull request object.',
    inputSchema: objectSchema({
      ...OWNER_REPO_PROPS,
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body text.' },
      head: { type: 'string', description: 'The branch to merge from; may carry an owner: prefix.' },
      base: { type: 'string', description: 'The branch to merge into.' },
    }, ['owner', 'repo', 'title', 'head', 'base']),
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch and return the merge result with the merge commit sha.',
    inputSchema: objectSchema({
      ...OWNER_REPO_PROPS,
      pull_number: { type: 'integer', description: 'The pull request number.' },
      commit_title: { type: 'string', description: 'An optional merge commit title (accepted; the squash commit uses the pull request title).' },
      commit_message: { type: 'string', description: 'An optional merge commit message (accepted; the squash commit uses the pull request body).' },
      merge_method: { type: 'string', description: 'The merge method (accepted; merges are squash merges).' },
    }, ['owner', 'repo', 'pull_number']),
  },
];

// --------------------------------------------------------------------------- helpers

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

interface RpcMessage {
  id?: unknown;
  hasId: boolean;
  method?: string;
  params: Record<string, unknown>;
}

function asMessage(value: unknown): RpcMessage | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const msg = value as Record<string, unknown>;
  return {
    id: msg.id,
    hasId: Object.prototype.hasOwnProperty.call(msg, 'id'),
    method: typeof msg.method === 'string' ? msg.method : undefined,
    params: msg.params !== null && typeof msg.params === 'object' && !Array.isArray(msg.params)
      ? (msg.params as Record<string, unknown>)
      : {},
  };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolOk(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
}

function toolErr(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify({ message }) }], isError: true };
}

/** Resolve owner/repo from explicit properties or a full_name of the form owner/repo. */
function resolveRepoArgs(args: Record<string, unknown>): { owner?: string; repo?: string } {
  let owner = str(args.owner);
  let repo = str(args.repo);
  const fullName = str(args.full_name);
  if ((!owner || !repo) && fullName) {
    const slash = fullName.indexOf('/');
    if (slash > 0) {
      owner = owner ?? fullName.slice(0, slash);
      repo = repo ?? fullName.slice(slash + 1);
    }
  }
  return { owner, repo };
}

// --------------------------------------------------------------------------- tools/call

function callTool(ctx: Ctx, rawName: string, args: Record<string, unknown>): Record<string, unknown> | { rpc: Record<string, unknown> } {
  const { forge } = ctx;
  let name = rawName.toLowerCase();
  const sep = name.lastIndexOf('__');
  if (sep !== -1) name = name.slice(sep + 2);
  const invalid = (message: string) => ({ rpc: rpcError(null, -32602, message) });

  const needRepo = (): RepoRec | { rpc: Record<string, unknown> } | { tool: Record<string, unknown> } => {
    const { owner, repo } = resolveRepoArgs(args);
    if (!owner || !repo) return invalid('Missing required argument: owner and repo (or full_name)');
    const found = forge.getRepo(owner, repo);
    if (!found) return { tool: toolErr('Not Found') };
    return found;
  };
  const isRpc = (v: unknown): v is { rpc: Record<string, unknown> } => typeof v === 'object' && v !== null && 'rpc' in (v as Record<string, unknown>);
  const isTool = (v: unknown): v is { tool: Record<string, unknown> } => typeof v === 'object' && v !== null && 'tool' in (v as Record<string, unknown>);

  switch (name) {
    case 'create_repo': {
      const repoName = str(args.name);
      if (!repoName) return invalid('Missing required argument: name');
      const viewer = forge.viewer.login;
      if (forge.getRepo(viewer, repoName)) return toolErr('Validation Failed: name already exists on this account');
      const repo = forge.createRepo(viewer, repoName, {
        description: str(args.description) ?? '',
        isPrivate: args.private === true,
      });
      return toolOk(serializeRepo(forge, repo));
    }
    case 'get_repo': {
      const repo = needRepo();
      if (isRpc(repo)) return repo;
      if (isTool(repo)) return repo.tool;
      return toolOk(serializeRepo(forge, repo));
    }
    case 'create_issue': {
      const title = str(args.title);
      if (!title) return invalid('Missing required argument: title');
      const repo = needRepo();
      if (isRpc(repo)) return repo;
      if (isTool(repo)) return repo.tool;
      const labelNames = Array.isArray(args.labels)
        ? args.labels.map((x) => (typeof x === 'string' ? x : (x !== null && typeof x === 'object' ? str((x as Record<string, unknown>).name) : undefined))).filter((x): x is string => x !== undefined)
        : [];
      const unknown = labelNames.filter((label) => !repo.labels.has(label));
      if (unknown.length > 0) return toolErr(`Validation Failed: unknown label ${unknown.join(', ')}`);
      const issue = forge.createIssue(repo, { title, body: str(args.body) ?? '', labels: labelNames });
      return toolOk(serializeIssue(forge, repo, issue));
    }
    case 'list_issues': {
      const repo = needRepo();
      if (isRpc(repo)) return repo;
      if (isTool(repo)) return repo.tool;
      const state = (str(args.state) ?? 'open').toLowerCase();
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      list.sort((a, b) => b.number - a.number);
      return toolOk(list.map((issue) => serializeIssue(forge, repo, issue)));
    }
    case 'create_pull_request': {
      const title = str(args.title);
      const headRaw = str(args.head);
      const baseRaw = str(args.base);
      if (!title) return invalid('Missing required argument: title');
      if (!headRaw) return invalid('Missing required argument: head');
      if (!baseRaw) return invalid('Missing required argument: base');
      const repo = needRepo();
      if (isRpc(repo)) return repo;
      if (isTool(repo)) return repo.tool;
      const stripOwner = (ref: string) => (ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref);
      const head = stripOwner(headRaw);
      const base = stripOwner(baseRaw);
      const headSha = forge.refCommit(repo, `refs/heads/${head}`);
      const baseSha = forge.refCommit(repo, `refs/heads/${base}`);
      if (!headSha) return toolErr('Validation Failed: head is invalid');
      if (!baseSha) return toolErr('Validation Failed: base is invalid');
      const pull = forge.createPull(repo, { title, body: str(args.body) ?? '', headRef: head, baseRef: base, headSha, baseSha });
      return toolOk(serializePull(forge, repo, pull));
    }
    case 'merge_pull_request': {
      const rawNumber = args.pull_number ?? args.number ?? args.pullNumber;
      const number = typeof rawNumber === 'number' ? rawNumber : (typeof rawNumber === 'string' ? Number(rawNumber) : NaN);
      if (!Number.isInteger(number)) return invalid('Missing required argument: pull_number');
      const repo = needRepo();
      if (isRpc(repo)) return repo;
      if (isTool(repo)) return repo.tool;
      const pull = repo.pulls.get(number);
      if (!pull) return toolErr('Not Found');
      if (pull.merged || pull.state === 'closed') return toolErr('Pull Request is not mergeable: already closed or merged');
      const sha = mergePullRequest(forge, repo, pull);
      if (!sha) return toolErr('Pull Request is not mergeable: merge conflict');
      return toolOk({ sha, merged: true, message: 'Pull Request successfully merged' });
    }
    default:
      return invalid(`Unknown tool: ${rawName}`);
  }
}

// --------------------------------------------------------------------------- dispatch

/** Answer one parsed message; null means "notification: no response body". */
function dispatch(ctx: Ctx, msg: RpcMessage): Record<string, unknown> | null {
  const isNotification = !msg.hasId || msg.method?.startsWith('notifications/') === true;
  if (msg.method === undefined) {
    return isNotification ? null : rpcError(msg.id, -32600, 'Invalid Request: method must be a string');
  }
  switch (msg.method) {
    case 'server/discover':
      return rpcResult(msg.id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'initialize': {
      const requested = str(msg.params.protocolVersion);
      const version = requested && SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(msg.id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(msg.id, {});
    case 'tools/list':
      return rpcResult(msg.id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = str(msg.params.name);
      if (!toolName) return rpcError(msg.id, -32602, 'Invalid params: tools/call requires a tool name');
      const args = msg.params.arguments !== null && typeof msg.params.arguments === 'object' && !Array.isArray(msg.params.arguments)
        ? (msg.params.arguments as Record<string, unknown>)
        : {};
      const out = callTool(ctx, toolName, args);
      if (typeof out === 'object' && out !== null && 'rpc' in out) {
        const err = (out as { rpc: Record<string, unknown> }).rpc;
        return { jsonrpc: '2.0', id: msg.id ?? null, error: (err as { error: unknown }).error };
      }
      return rpcResult(msg.id, out);
    }
    default:
      if (isNotification) return null;
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(
  ctx: Ctx,
  req: RequestData,
  res: ServerResponse,
  sendJson: SendJson,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, rpcError(null, -32601, 'Method not allowed: /mcp speaks POST'));
    return;
  }
  if (req.jsonMalformed || (req.json === null && req.jsonArray === null)) {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error: body is not valid JSON'));
    return;
  }
  if (!req.authed) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }

  if (req.jsonArray !== null) {
    const answers: Record<string, unknown>[] = [];
    for (const item of req.jsonArray) {
      const msg = asMessage(item);
      if (msg === null) {
        answers.push(rpcError(null, -32600, 'Invalid Request: each batch entry must be an object'));
        continue;
      }
      const answer = dispatch(ctx, msg);
      if (answer !== null) answers.push(answer);
    }
    if (answers.length === 0) {
      res.writeHead(202, { 'x-github-request-id': 'core-forge-mcp' });
      res.end();
      return;
    }
    sendJson(res, 200, answers);
    return;
  }

  const msg = asMessage(req.json);
  if (msg === null) {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request: body must be a JSON-RPC object'));
    return;
  }
  const answer = dispatch(ctx, msg);
  if (answer === null) {
    res.writeHead(202, { 'x-github-request-id': 'core-forge-mcp' });
    res.end();
    return;
  }
  sendJson(res, 200, answer);
}
