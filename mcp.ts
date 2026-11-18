// mcp.ts — Model Context Protocol over streamable HTTP (JSON-RPC 2.0).
//
// Answers are plain application/json, never SSE. Six tools act on the same
// store as REST, so an object created over MCP reads back over /api/v3
// unchanged. Tool-level failures ride inside a 200 result with isError;
// RPC-level failures (unknown tool, missing argument) are JSON-RPC errors.

import { VIEWER_LOGIN, type Forge, type RepoRec } from './store.ts';
import { refCommit } from './gitcore.ts';
import {
  hasAuth,
  mergePullRequest,
  sendJson,
  serializeIssue,
  serializePull,
  serializeRepo,
  type RequestContext,
} from './app.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_REQUEST_ID = 'core-forge-mcp';

interface RpcErrorBody {
  code: number;
  message: string;
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

// ---- tool catalogue ---------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, { type: string; description: string }>;
    additionalProperties: boolean;
    required: string[];
  };
}

function prop(type: string, description: string): { type: string; description: string } {
  return { type, description };
}

const REPO_PROPS = {
  owner: prop('string', 'The repository owner login.'),
  repo: prop('string', 'The repository name.'),
  full_name: prop('string', 'The repository full name, as owner/repo.'),
};

export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user and return the repository object.',
    inputSchema: {
      type: 'object',
      properties: {
        name: prop('string', 'The repository name.'),
        description: prop('string', 'A short description of the repository.'),
        private: prop('boolean', 'Whether the repository is private.'),
      },
      additionalProperties: true,
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name and return the repository object.',
    inputSchema: { type: 'object', properties: { ...REPO_PROPS }, additionalProperties: true, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository and return the issue object.',
    inputSchema: {
      type: 'object',
      properties: {
        ...REPO_PROPS,
        title: prop('string', 'The issue title.'),
        body: prop('string', 'The issue body text.'),
        labels: prop('array', 'Label names to attach; each label must already exist on the repository.'),
      },
      additionalProperties: true,
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, newest first, optionally filtered by state (open, closed or all).',
    inputSchema: {
      type: 'object',
      properties: {
        ...REPO_PROPS,
        state: prop('string', 'Filter by issue state: open, closed or all. Defaults to open.'),
      },
      additionalProperties: true,
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch to a base branch in a repository and return the pull request object.',
    inputSchema: {
      type: 'object',
      properties: {
        ...REPO_PROPS,
        title: prop('string', 'The pull request title.'),
        body: prop('string', 'The pull request body text.'),
        head: prop('string', 'The branch to merge from; may carry an owner: prefix.'),
        base: prop('string', 'The branch to merge into.'),
      },
      additionalProperties: true,
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch and return the merge result with the merge commit sha.',
    inputSchema: {
      type: 'object',
      properties: {
        ...REPO_PROPS,
        pull_number: prop('integer', 'The pull request number.'),
        commit_title: prop('string', 'An optional merge commit title (accepted; the squash commit uses the pull request title).'),
        commit_message: prop('string', 'An optional merge commit message (accepted; the squash commit uses the pull request body).'),
        merge_method: prop('string', 'The merge method (accepted; merges are squash merges).'),
      },
      additionalProperties: true,
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// ---- tool implementations ---------------------------------------------------

type ToolOutcome = { rpcError: RpcErrorBody } | { result: Record<string, unknown> };

function missingArg(message: string): ToolOutcome {
  return { rpcError: { code: -32602, message } };
}

function repoFromArgs(forge: Forge, args: Record<string, unknown>): RepoRec | ToolOutcome {
  let owner = typeof args.owner === 'string' ? args.owner : undefined;
  let repoName = typeof args.repo === 'string' ? args.repo : undefined;
  if ((owner === undefined || repoName === undefined) && typeof args.full_name === 'string') {
    const slash = args.full_name.indexOf('/');
    if (slash >= 0) {
      owner ??= args.full_name.slice(0, slash);
      repoName ??= args.full_name.slice(slash + 1);
    }
  }
  if (owner === undefined || owner === '' || repoName === undefined || repoName === '') {
    return missingArg('Missing required argument: owner and repo (or full_name)');
  }
  const repo = forge.repoByKey(owner, repoName);
  if (!repo) return { result: toolErr('Not Found') };
  return repo;
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') names.push(item);
    else if (item !== null && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string') {
      names.push((item as Record<string, unknown>).name as string);
    }
  }
  return names;
}

function stripOwnerPrefix(ref: string): string {
  const at = ref.indexOf(':');
  return at >= 0 ? ref.slice(at + 1) : ref;
}

function callTool(forge: Forge, sentName: string, args: Record<string, unknown>): ToolOutcome {
  const name = sentName.toLowerCase().split('__').pop() ?? sentName.toLowerCase();
  if (name === 'create_repo') {
    const repoName = typeof args.name === 'string' ? args.name : undefined;
    if (repoName === undefined || repoName === '') return missingArg('Missing required argument: name');
    if (forge.repoByKey(VIEWER_LOGIN, repoName)) {
      return { result: toolErr('Validation Failed: name already exists on this account') };
    }
    const repo = forge.createRepo(
      VIEWER_LOGIN,
      repoName,
      typeof args.description === 'string' ? args.description : '',
      args.private === true,
    );
    return { result: toolOk(serializeRepo(forge, repo)) };
  }
  if (name === 'get_repo' || name === 'list_issues' || name === 'create_issue' || name === 'create_pull_request' || name === 'merge_pull_request') {
    const repoOrOutcome = repoFromArgs(forge, args);
    if ('rpcError' in repoOrOutcome || 'result' in repoOrOutcome) return repoOrOutcome;
    const repo = repoOrOutcome;
    if (name === 'get_repo') return { result: toolOk(serializeRepo(forge, repo)) };
    if (name === 'list_issues') {
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      let issues = [...repo.issues.values()].sort((a, b) => b.number - a.number);
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      return { result: toolOk(issues.map((issue) => serializeIssue(forge, repo, issue))) };
    }
    if (name === 'create_issue') {
      const title = typeof args.title === 'string' ? args.title : undefined;
      if (title === undefined || title === '') return missingArg('Missing required argument: title');
      const labels = labelNames(args.labels);
      const unknown = labels.filter((label) => !repo.labels.has(label));
      if (unknown.length > 0) return { result: toolErr(`Validation Failed: unknown label ${unknown.join(', ')}`) };
      const issue = forge.createIssue(repo, title, typeof args.body === 'string' ? args.body : '', labels);
      return { result: toolOk(serializeIssue(forge, repo, issue)) };
    }
    if (name === 'create_pull_request') {
      const title = typeof args.title === 'string' ? args.title : undefined;
      const head = typeof args.head === 'string' ? args.head : undefined;
      const base = typeof args.base === 'string' ? args.base : undefined;
      if (title === undefined || title === '') return missingArg('Missing required argument: title');
      if (head === undefined || head === '') return missingArg('Missing required argument: head');
      if (base === undefined || base === '') return missingArg('Missing required argument: base');
      const headRef = stripOwnerPrefix(head);
      const baseRef = stripOwnerPrefix(base);
      const headSha = refCommit(forge, repo, `refs/heads/${headRef}`);
      if (headSha === null) return { result: toolErr('Validation Failed: head is invalid') };
      const baseSha = refCommit(forge, repo, `refs/heads/${baseRef}`);
      if (baseSha === null) return { result: toolErr('Validation Failed: base is invalid') };
      const pull = forge.createPull(repo, title, typeof args.body === 'string' ? args.body : '', headRef, baseRef, headSha, baseSha);
      return { result: toolOk(serializePull(forge, repo, pull)) };
    }
    // merge_pull_request
    const rawNumber = args.pull_number ?? args.number ?? args.pullNumber;
    const pullNumber = typeof rawNumber === 'string' ? Number(rawNumber) : rawNumber;
    if (typeof pullNumber !== 'number' || !Number.isInteger(pullNumber)) {
      return missingArg('Missing required argument: pull_number');
    }
    const pull = repo.pulls.get(pullNumber);
    if (!pull) return { result: toolErr('Not Found') };
    if (pull.merged || pull.state === 'closed') {
      return { result: toolErr('Pull Request is not mergeable: already closed or merged') };
    }
    const sha = mergePullRequest(forge, repo, pull);
    if (sha === null) return { result: toolErr('Pull Request is not mergeable: merge conflict') };
    return { result: toolOk({ sha, merged: true, message: 'Pull Request successfully merged' }) };
  }
  return { rpcError: { code: -32602, message: `Unknown tool: ${sentName}` } };
}

// ---- message dispatch -------------------------------------------------------

function isNotification(message: Record<string, unknown>): boolean {
  return !Object.prototype.hasOwnProperty.call(message, 'id') || (typeof message.method === 'string' && message.method.startsWith('notifications/'));
}

/** Answer one JSON-RPC message, or null when it is a notification. */
function dispatch(forge: Forge, message: Record<string, unknown>): Record<string, unknown> | null {
  const id = Object.prototype.hasOwnProperty.call(message, 'id') ? message.id : undefined;
  const method = message.method;
  if (method === undefined) {
    if (id === undefined) return null;
    return rpcError(id, -32600, 'Invalid Request: method must be a string');
  }
  if (typeof method !== 'string') {
    if (id === undefined) return null;
    return rpcError(id, -32600, 'Invalid Request: method must be a string');
  }
  if (method.startsWith('notifications/')) return null;
  if (id === undefined) return null;
  const paramsRaw = message.params;
  const params =
    paramsRaw !== null && typeof paramsRaw === 'object' && !Array.isArray(paramsRaw)
      ? (paramsRaw as Record<string, unknown>)
      : {};
  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: 'core-forge', version: '1.0.0' },
    });
  }
  if (method === 'initialize') {
    const requested = params.protocolVersion;
    const protocolVersion =
      typeof requested === 'string' && SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'core-forge', version: '1.0.0' },
    });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const toolName = params.name;
    if (typeof toolName !== 'string' || toolName === '') {
      return rpcError(id, -32602, 'Invalid params: tools/call requires a tool name');
    }
    const argsRaw = params.arguments;
    const args =
      argsRaw !== null && typeof argsRaw === 'object' && !Array.isArray(argsRaw)
        ? (argsRaw as Record<string, unknown>)
        : {};
    const outcome = callTool(forge, toolName, args);
    if ('rpcError' in outcome) return rpcError(id, outcome.rpcError.code, outcome.rpcError.message);
    return rpcResult(id, outcome.result);
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

// ---- HTTP entry point -------------------------------------------------------

export async function handleMcp(forge: Forge, ctx: RequestContext): Promise<void> {
  const { res } = ctx;
  if (ctx.method !== 'POST') {
    sendJson(res, 405, rpcError(null, -32601, 'Method not allowed: /mcp speaks POST'));
    return;
  }
  // The parse check runs before the auth check.
  if (ctx.body.malformed || (ctx.body.json === null && ctx.body.jsonArray === null)) {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error: body is not valid JSON'));
    return;
  }
  if (!hasAuth(ctx.req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  if (ctx.body.jsonArray !== null) {
    const answers: Record<string, unknown>[] = [];
    for (const entry of ctx.body.jsonArray) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        answers.push(rpcError(null, -32600, 'Invalid Request: each batch entry must be an object'));
        continue;
      }
      const answer = dispatch(forge, entry as Record<string, unknown>);
      if (answer !== null) answers.push(answer);
    }
    if (answers.length === 0) {
      res.writeHead(202, { 'x-github-request-id': MCP_REQUEST_ID });
      res.end();
      return;
    }
    sendJson(res, 200, answers);
    return;
  }
  const message = ctx.body.json as Record<string, unknown>;
  if (isNotification(message)) {
    res.writeHead(202, { 'x-github-request-id': MCP_REQUEST_ID });
    res.end();
    return;
  }
  const answer = dispatch(forge, message);
  if (answer === null) {
    res.writeHead(202, { 'x-github-request-id': MCP_REQUEST_ID });
    res.end();
    return;
  }
  sendJson(res, 200, answer);
}
