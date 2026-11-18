// store.ts — the forge's state: users, repositories (with their git refs), issues, pull requests,
// comments and labels, all in memory over one shared ObjectStore. A deterministic clock (seeded
// from MAKEFUN_TRIAL_NOW, advanced by a counter) keeps every exported byte reproducible.

import {
  ObjectStore, buildTreeFromFiles, flattenTree, parseCommit, peelToCommit,
} from './gitcore.ts';

export interface UserRec {
  login: string;
  id: number;
  name: string;
}

export interface CommentRec {
  id: number;
  body: string;
  createdSeq: number;
}

export interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  nextCommentId: number;
  createdSeq: number;
}

export interface PullRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  createdHeadSha: string;
  createdBaseSha: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface LabelRec {
  name: string;
  color: string;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  labels: Map<string, LabelRec>;
  nextNumber: number;
  createdSeq: number;
}

export class Forge {
  readonly store = new ObjectStore();
  readonly users = new Map<string, UserRec>();
  readonly repos = new Map<string, RepoRec>();
  readonly repoOrder: RepoRec[] = [];
  private seq = 0;
  private clockTicks = 0;
  private readonly clockBaseMs: number;
  private nextRepoId = 100001;
  /** Viewer identity for the trial: the suite's one scenario user. */
  readonly viewer: UserRec;

  constructor() {
    const nowEnv = process.env.MAKEFUN_TRIAL_NOW;
    const parsed = nowEnv ? Date.parse(nowEnv) : NaN;
    this.clockBaseMs = Number.isFinite(parsed) ? parsed : Date.parse('2026-01-01T00:00:00Z');
    this.viewer = { login: 'adaiversen', id: 1000, name: 'ada iversen' };
    this.users.set(this.viewer.login, this.viewer);
    this.users.set('quinnkeller', { login: 'quinnkeller', id: 1001, name: 'quinn keller' });
    this.users.set('olgabauer', { login: 'olgabauer', id: 1002, name: 'olga bauer' });
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Deterministic timestamp: trial base + one second per call, in call order. */
  nowIso(): string {
    const ms = this.clockBaseMs + this.clockTicks * 1000;
    this.clockTicks += 1;
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  nowEpochSeconds(): number {
    const seconds = Math.floor(this.clockBaseMs / 1000) + this.clockTicks;
    this.clockTicks += 1;
    return seconds;
  }

  // ------------------------------------------------------------------ repositories

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, init: { description?: string; isPrivate?: boolean }): RepoRec {
    const repo: RepoRec = {
      id: this.nextRepoId,
      owner,
      name,
      description: init.description ?? '',
      isPrivate: init.isPrivate ?? false,
      defaultBranch: 'main',
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      createdSeq: this.nextSeq(),
    };
    this.nextRepoId += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    this.repoOrder.push(repo);
    return repo;
  }

  deleteRepo(repo: RepoRec): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
    const index = this.repoOrder.indexOf(repo);
    if (index !== -1) this.repoOrder.splice(index, 1);
  }

  reposOf(owner: string): RepoRec[] {
    return this.repoOrder.filter((repo) => repo.owner === owner);
  }

  // ------------------------------------------------------------------ git helpers over a repo

  refTip(repo: RepoRec, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  branchTip(repo: RepoRec, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** The commit oid a ref points at (peeling tags), or null when unborn/unknown. */
  refCommit(repo: RepoRec, ref: string): string | null {
    const oid = repo.refs.get(ref);
    if (!oid) return null;
    return peelToCommit(this.store, oid);
  }

  defaultTip(repo: RepoRec): string | null {
    return this.refCommit(repo, `refs/heads/${repo.defaultBranch}`);
  }

  /** Files (path -> {mode, oid}) at a commit oid; empty map for null. */
  filesAt(commitOid: string | null): Map<string, { mode: string; oid: string }> {
    if (!commitOid) return new Map();
    const obj = this.store.get(commitOid);
    if (!obj || obj.type !== 'commit') return new Map();
    return flattenTree(this.store, parseCommit(obj.data).tree);
  }

  /** Create a commit on top of `parent` (or a root commit) with the given file map. */
  commitFiles(repo: RepoRec, files: Map<string, { mode: string; oid: string }>, parent: string | null, message: string): string {
    const tree = buildTreeFromFiles(this.store, files);
    const seconds = this.nowEpochSeconds();
    const identity = `${this.viewer.name} <${this.viewer.login}@forge.local>`;
    const lines = [`tree ${tree}`];
    if (parent) lines.push(`parent ${parent}`);
    lines.push(`author ${identity} ${seconds} +0000`);
    lines.push(`committer ${identity} ${seconds} +0000`);
    const data = Buffer.from(`${lines.join('\n')}\n\n${message}\n`, 'utf8');
    return this.store.put('commit', data);
  }

  // ------------------------------------------------------------------ issues & pulls

  createIssue(repo: RepoRec, init: { title: string; body?: string; labels?: string[] }): IssueRec {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue: IssueRec = {
      number,
      title: init.title,
      body: init.body ?? '',
      state: 'open',
      labels: [...(init.labels ?? [])],
      comments: [],
      nextCommentId: 1,
      createdSeq: this.nextSeq(),
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createPull(repo: RepoRec, init: { title: string; body?: string; headRef: string; baseRef: string; headSha: string; baseSha: string }): PullRec {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pull: PullRec = {
      number,
      title: init.title,
      body: init.body ?? '',
      state: 'open',
      merged: false,
      headRef: init.headRef,
      baseRef: init.baseRef,
      createdHeadSha: init.headSha,
      createdBaseSha: init.baseSha,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.nextSeq(),
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  // ------------------------------------------------------------------ global ids (GraphQL)

  globalId(kind: 'repo' | 'issue' | 'pull' | 'comment', repo: RepoRec, number?: number, commentId?: number): string {
    let raw: string;
    if (kind === 'repo') raw = `repo:${repo.id}`;
    else if (kind === 'issue') raw = `issue:${repo.id}:${number}`;
    else if (kind === 'pull') raw = `pull:${repo.id}:${number}`;
    else raw = `comment:${repo.id}:${number}:${commentId}`;
    return Buffer.from(raw, 'utf8').toString('base64');
  }

  /** Decode a global id produced by globalId(); null when the shape is foreign. */
  parseGlobalId(id: string): { kind: string; repoId: number; number?: number; commentId?: number } | null {
    let raw: string;
    try {
      raw = Buffer.from(id, 'base64').toString('utf8');
    } catch {
      return null;
    }
    const parts = raw.split(':');
    if (parts[0] === 'repo' && parts.length === 2) return { kind: 'repo', repoId: Number(parts[1]) };
    if (parts[0] === 'issue' && parts.length === 3) return { kind: 'issue', repoId: Number(parts[1]), number: Number(parts[2]) };
    if (parts[0] === 'pull' && parts.length === 3) return { kind: 'pull', repoId: Number(parts[1]), number: Number(parts[2]) };
    if (parts[0] === 'comment' && parts.length === 4) return { kind: 'comment', repoId: Number(parts[1]), number: Number(parts[2]), commentId: Number(parts[3]) };
    return null;
  }

  repoById(id: number): RepoRec | undefined {
    return this.repoOrder.find((repo) => repo.id === id);
  }

  // ------------------------------------------------------------------ deterministic export

  /**
   * Serialize the whole forge deterministically: repositories in creation order, refs sorted,
   * issues/pulls by number, git objects sorted by oid with base64 payloads. Two runs of the
   * same trial produce byte-identical output.
   */
  exportState(): string {
    const repos = this.repoOrder.map((repo) => ({
      id: repo.id,
      owner: repo.owner,
      name: repo.name,
      description: repo.description,
      private: repo.isPrivate,
      default_branch: repo.defaultBranch,
      refs: [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([ref, oid]) => ({ ref, oid })),
      labels: [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map((label) => ({ name: label.name, color: label.color })),
      issues: [...repo.issues.values()].sort((a, b) => a.number - b.number).map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: [...issue.labels].sort(),
        comments: issue.comments.map((comment) => ({ id: comment.id, body: comment.body })),
      })),
      pulls: [...repo.pulls.values()].sort((a, b) => a.number - b.number).map((pull) => ({
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        merged: pull.merged,
        head: pull.headRef,
        base: pull.baseRef,
        head_sha: pull.createdHeadSha,
        base_sha: pull.createdBaseSha,
        merged_at: pull.mergedAt,
        merge_commit_sha: pull.mergeCommitSha,
      })),
    }));
    const objects = [...this.store.objects.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([oid, obj]) => ({ oid, type: obj.type, data: obj.data.toString('base64') }));
    return JSON.stringify({ version: 1, repos, objects });
  }
}
