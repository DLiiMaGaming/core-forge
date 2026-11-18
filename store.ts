// store.ts — the forge's in-memory state.
//
// Everything the forge serves lives here: the three seeded users, every
// repository with its refs/issues/pulls/labels, and the git object store.
// Nothing in this file touches the wall clock or unseeded randomness: all
// timestamps derive from a seeded, ticking clock, and every id derives from
// counters and creation order, so two runs of the same request sequence
// leave byte-identical state exports.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const COMMIT_AUTHOR = 'ada iversen <adaiversen@forge.local>';
export const EPOCH_BASE = '2026-01-01T00:00:00Z';

export interface UserRec {
  login: string;
  id: number;
  name: string;
}

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
  createdSeq: number;
}

export type IssueState = 'open' | 'closed';

export interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  comments: CommentRec[];
  nextCommentId: number;
  createdSeq: number;
}

export interface PullRec {
  number: number;
  title: string;
  body: string;
  state: IssueState;
  merged: boolean;
  headRef: string;
  baseRef: string;
  createdHeadSha: string;
  createdBaseSha: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
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

export interface StoredObject {
  type: string;
  data: Buffer;
}

/** Git object id: SHA-1 over "<type> <len>\0" + payload. */
export function oidOf(type: string, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** ISO-8601 without milliseconds, e.g. 2026-01-01T00:00:00Z. */
export function isoNoMillis(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** REST-facing derived id: repo id scaled, plus the issue/pull number. */
export function restId(repoId: number, number: number): number {
  return repoId * 1_000_000 + number;
}

export function commentRestId(repoId: number, number: number, commentId: number): number {
  return repoId * 1_000_000 + number * 1000 + commentId;
}

/** Global (GraphQL node) id: base64 of a colon-joined key. */
export function globalId(kind: string, repoId: number, number?: number, commentId?: number): string {
  const parts = [kind, String(repoId)];
  if (number !== undefined) parts.push(String(number));
  if (commentId !== undefined) parts.push(String(commentId));
  return Buffer.from(parts.join(':'), 'utf8').toString('base64');
}

export interface ParsedGlobalId {
  kind: string;
  repoId: number;
  number?: number;
  commentId?: number;
}

/** Decode a global id, or null when it does not match a known shape. */
export function parseGlobalId(id: string): ParsedGlobalId | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = text.split(':');
  if (parts.length < 2 || parts.length > 4) return null;
  const kind = parts[0];
  const repoId = Number(parts[1]);
  if (!Number.isInteger(repoId)) return null;
  if (kind === 'repo' && parts.length === 2) return { kind, repoId };
  if ((kind === 'issue' || kind === 'pull') && parts.length === 3) {
    const number = Number(parts[2]);
    if (!Number.isInteger(number)) return null;
    return { kind, repoId, number };
  }
  if (kind === 'comment' && parts.length === 4) {
    const number = Number(parts[2]);
    const commentId = Number(parts[3]);
    if (!Number.isInteger(number) || !Number.isInteger(commentId)) return null;
    return { kind, repoId, number, commentId };
  }
  return null;
}

export class Forge {
  readonly users = new Map<string, UserRec>();
  readonly repos = new Map<string, RepoRec>();
  readonly repoOrder: RepoRec[] = [];
  readonly objects = new Map<string, StoredObject>();
  private nextRepoId = 100001;
  private seq = 0;
  private clockTicks = 0;
  private readonly baseMs: number;

  constructor() {
    const seed = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = seed === '' ? NaN : Date.parse(seed);
    this.baseMs = Number.isNaN(parsed) ? Date.parse(EPOCH_BASE) : parsed;
    for (const [login, id, name] of [
      ['adaiversen', 1000, 'ada iversen'],
      ['quinnkeller', 1001, 'quinn keller'],
      ['olgabauer', 1002, 'olga bauer'],
    ] as const) {
      this.users.set(login, { login, id, name });
    }
  }

  /** The single global creation-order counter. */
  nextSeq(): number {
    const value = this.seq;
    this.seq += 1;
    return value;
  }

  /** Display timestamp for a record: base + its creation sequence, in seconds. */
  isoAt(seq: number): string {
    return isoNoMillis(this.baseMs + seq * 1000);
  }

  /** Deterministic clock: base + one second per tick. */
  nowIso(): string {
    const value = isoNoMillis(this.baseMs + this.clockTicks * 1000);
    this.clockTicks += 1;
    return value;
  }

  /** Deterministic clock in epoch seconds, one tick per call. */
  nowEpochSeconds(): number {
    const value = Math.floor(this.baseMs / 1000) + this.clockTicks;
    this.clockTicks += 1;
    return value;
  }

  // ---- git objects -------------------------------------------------------

  putObject(type: string, data: Buffer): string {
    const oid = oidOf(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): StoredObject | undefined {
    return this.objects.get(oid);
  }

  hasObject(oid: string): boolean {
    return this.objects.has(oid);
  }

  // ---- repositories ------------------------------------------------------

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  repoByKey(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  repoById(id: number): RepoRec | undefined {
    return this.repoOrder.find((repo) => repo.id === id);
  }

  reposOf(owner: string): RepoRec[] {
    return this.repoOrder.filter((repo) => repo.owner === owner);
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): RepoRec {
    const repo: RepoRec = {
      id: this.nextRepoId,
      owner,
      name,
      description,
      isPrivate,
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
    const at = this.repoOrder.indexOf(repo);
    if (at >= 0) this.repoOrder.splice(at, 1);
  }

  // ---- issues and pulls (one shared number counter per repo) -------------

  createIssue(repo: RepoRec, title: string, body: string, labels: string[]): IssueRec {
    const issue: IssueRec = {
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      nextCommentId: 1,
      createdSeq: this.nextSeq(),
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPull(
    repo: RepoRec,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
    headSha: string,
    baseSha: string,
  ): PullRec {
    const pull: PullRec = {
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      headRef,
      baseRef,
      createdHeadSha: headSha,
      createdBaseSha: baseSha,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.nextSeq(),
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  // ---- deterministic export ----------------------------------------------

  /** Byte-identical export of the whole forge state (see GET /__makefun/state). */
  exportState(): string {
    const repos = this.repoOrder.map((repo) => ({
      id: repo.id,
      owner: repo.owner,
      name: repo.name,
      description: repo.description,
      private: repo.isPrivate,
      default_branch: repo.defaultBranch,
      refs: [...repo.refs.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([ref, oid]) => ({ ref, oid })),
      labels: [...repo.labels.values()]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((label) => ({ name: label.name, color: label.color })),
      issues: [...repo.issues.values()]
        .sort((a, b) => a.number - b.number)
        .map((issue) => ({
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: [...issue.labels].sort(),
          comments: issue.comments.map((comment) => ({ id: comment.id, body: comment.body })),
        })),
      pulls: [...repo.pulls.values()]
        .sort((a, b) => a.number - b.number)
        .map((pull) => ({
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
    const objects = [...this.objects.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([oid, obj]) => ({ oid, type: obj.type, data: obj.data.toString('base64') }));
    return JSON.stringify({ version: 1, repos, objects });
  }
}
