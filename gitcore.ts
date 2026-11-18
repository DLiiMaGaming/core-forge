// gitcore.ts — the git object model and packfile codec.
//
// Pure functions over a Forge's object store: trees and commits, the commit
// graph (ancestry, merge bases), three-way file merges, and packfile v2
// reading/writing (full objects plus OFS/REF deltas on read). No I/O, no
// clock, no randomness — every result is a function of the objects it reads.

import { createHash } from 'node:crypto';
import { inflateSync as zlibInflate } from 'node:zlib';
import { deflateSync as zlibDeflate } from 'node:zlib';
import { COMMIT_AUTHOR, ZERO_OID, type Forge, type RepoRec } from './store.ts';

export { ZERO_OID };

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  message: string;
}

export interface FileEntry {
  mode: string;
  oid: string;
}

export type FileMap = Map<string, FileEntry>;

const PACK_TYPE_IDS: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_ID_TYPES: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Sort key for tree entries: directories compare as if named with a '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const ka = treeSortKey(a);
  const kb = treeSortKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** Encode one tree's entries to their binary form, git-sorted. */
export function encodeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object's binary form into its entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(pos, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Build a tree object from a flat path map, creating intermediate trees. */
export function buildTreeFromFiles(forge: Forge, files: FileMap): string {
  interface DirNode {
    files: Map<string, FileEntry>;
    dirs: Map<string, DirNode>;
  }
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let child = node.dirs.get(parts[i]);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1], entry);
  }
  const emit = (node: DirNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: emit(child) });
    return forge.putObject('tree', encodeTree(entries));
  };
  return emit(root);
}

/** Flatten a tree object into a path map (directories walked, files kept). */
export function flattenTree(forge: Forge, treeOid: string, prefix = '', out: FileMap = new Map()): FileMap {
  const obj = forge.getObject(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(forge, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** The tree oid of one directory inside a root tree, or null. */
export function subtreeAt(forge: Forge, rootTreeOid: string, dirPath: string): string | null {
  if (dirPath === '') return rootTreeOid;
  let current = rootTreeOid;
  for (const segment of dirPath.split('/')) {
    const obj = forge.getObject(current);
    if (!obj || obj.type !== 'tree') return null;
    const next = parseTree(obj.data).find((entry) => entry.mode === '40000' && entry.name === segment);
    if (!next) return null;
    current = next.oid;
  }
  return current;
}

/** Parse a commit object's headers and message. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

/** Create a commit object over a full file map and store it. */
export function commitFiles(
  forge: Forge,
  files: FileMap,
  parent: string | null,
  message: string,
): string {
  const treeOid = buildTreeFromFiles(forge, files);
  const epoch = forge.nowEpochSeconds();
  const lines = [`tree ${treeOid}`];
  if (parent !== null) lines.push(`parent ${parent}`);
  lines.push(`author ${COMMIT_AUTHOR} ${epoch} +0000`);
  lines.push(`committer ${COMMIT_AUTHOR} ${epoch} +0000`);
  lines.push('');
  lines.push(message.endsWith('\n') ? message : `${message}\n`);
  return forge.putObject('commit', Buffer.from(lines.join('\n'), 'utf8'));
}

/** All files of a commit, as a path map (empty map for a missing commit). */
export function filesAt(forge: Forge, commitOid: string | null): FileMap {
  if (commitOid === null) return new Map();
  const obj = forge.getObject(commitOid);
  if (!obj || obj.type !== 'commit') return new Map();
  return flattenTree(forge, parseCommit(obj.data).tree);
}

/** Follow annotated tags (up to 16 hops) to the commit they point at. */
export function peelToCommit(forge: Forge, oid: string): string | null {
  let current = oid;
  for (let hop = 0; hop <= 16; hop += 1) {
    const obj = forge.getObject(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (!match) return null;
    current = match[1];
  }
  return null;
}

/** The commit closure of a set of starts; stopAt commits are kept but not walked past. */
export function commitClosure(forge: Forge, starts: Iterable<string>, stopAt?: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...starts];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = forge.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    if (stopAt?.has(oid)) continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return seen;
}

/** True when ancestor equals descendant or is reachable from it via parents. */
export function isAncestor(forge: Forge, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const queue = [descendant];
  for (let head = 0; head < queue.length; head += 1) {
    const oid = queue[head];
    const obj = forge.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** The merge base of two commits, or null when their histories never meet. */
export function mergeBase(forge: Forge, a: string, b: string): string | null {
  if (a === b) return a;
  if (isAncestor(forge, b, a)) return b;
  if (isAncestor(forge, a, b)) return a;
  const seen = new Set<string>([b]);
  const queue = [b];
  for (let head = 0; head < queue.length; head += 1) {
    const oid = queue[head];
    const obj = forge.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (isAncestor(forge, parent, a)) return parent;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return null;
}

/** Every object reachable from a commit set: each commit + its full tree recursively. */
export function objectClosure(forge: Forge, commits: Iterable<string>, excludeCommits?: Set<string>): Set<string> {
  const keep = new Set<string>();
  // NOTE: only the commits given are included — their parents are NOT walked.
  // The caller computes the commit set (full closure, or a depth-limited set).
  for (const commitOid of commits) {
    const obj = forge.getObject(commitOid);
    if (!obj || obj.type !== 'commit') continue;
    keep.add(commitOid);
    const treeOid = parseCommit(obj.data).tree;
    const walk = (tree: string): void => {
      if (keep.has(tree)) return;
      keep.add(tree);
      const treeObj = forge.getObject(tree);
      if (!treeObj || treeObj.type !== 'tree') return;
      for (const entry of parseTree(treeObj.data)) {
        if (entry.mode === '40000') walk(entry.oid);
        else keep.add(entry.oid);
      }
    };
    walk(treeOid);
  }
  if (excludeCommits && excludeCommits.size > 0) {
    const excluded = new Set<string>();
    for (const commitOid of excludeCommits) {
      excluded.add(commitOid);
      const obj = forge.getObject(commitOid);
      if (!obj || obj.type !== 'commit') continue;
      const walk = (tree: string): void => {
        if (excluded.has(tree)) return;
        excluded.add(tree);
        const treeObj = forge.getObject(tree);
        if (!treeObj || treeObj.type !== 'tree') return;
        for (const entry of parseTree(treeObj.data)) {
          if (entry.mode === '40000') walk(entry.oid);
          else excluded.add(entry.oid);
        }
      };
      walk(parseCommit(obj.data).tree);
    }
    for (const oid of excluded) keep.delete(oid);
  }
  return keep;
}

/**
 * Three-way merge of file maps. A path takes the side that changed it when
 * only one side did; both sides changing it differently is a conflict and
 * the path is reported and left out. Returns null on any conflict.
 */
export function mergeFileMaps(
  base: FileMap,
  ours: FileMap,
  theirs: FileMap,
  conflicts: string[],
): FileMap | null {
  const out: FileMap = new Map();
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const same = (a?: FileEntry, b?: FileEntry): boolean =>
    (a === undefined && b === undefined) ||
    (a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (same(o, t)) {
      if (o !== undefined) out.set(path, o);
    } else if (same(b, o)) {
      if (t !== undefined) out.set(path, t);
    } else if (same(b, t)) {
      if (o !== undefined) out.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  return conflicts.length > 0 ? null : out;
}

// ---- packfiles ------------------------------------------------------------

/** Encode the variable-length type/size header of one pack object. */
function packObjectHeader(typeId: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeId << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let next = size & 0x7f;
    size >>= 7;
    if (size > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

/** Serialize oids as a packfile v2 of full (never delta) objects. */
export function writePack(forge: Forge, oids: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK'), Buffer.alloc(4), Buffer.alloc(4)];
  parts[1].writeUInt32BE(2, 0);
  parts[2].writeUInt32BE(oids.length, 0);
  for (const oid of oids) {
    const obj = forge.getObject(oid);
    if (!obj) throw new Error(`writePack: unknown object ${oid}`);
    const typeId = PACK_TYPE_IDS[obj.type];
    if (typeId === undefined) throw new Error(`writePack: unknown object type ${obj.type}`);
    parts.push(packObjectHeader(typeId, obj.data.length));
    parts.push(zlibDeflate(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

interface PackObjectHeader {
  typeId: number;
  size: number;
  next: number;
}

/** Read one pack object header at a position. */
function readPackObjectHeader(pack: Buffer, pos: number): PackObjectHeader {
  let byte = pack[pos];
  const typeId = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let next = pos + 1;
  while (byte & 0x80) {
    byte = pack[next];
    next += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { typeId, size, next };
}

/** Inflate exactly `size` bytes from a slice; find the true stream end by search. */
function inflateBounded(pack: Buffer, start: number, size: number): { raw: Buffer; end: number } {
  // Node's inflate ignores trailing bytes, so any end past the stream's true
  // end inflates to the same output; any end before it throws. The smallest
  // end that inflates to exactly the declared size is therefore the true end.
  const tryEnd = (end: number): Buffer | null => {
    try {
      const raw = zlibInflate(pack.subarray(start, end));
      return raw.length === size ? raw : null;
    } catch {
      return null;
    }
  };
  let low = start;
  let high = pack.length;
  if (tryEnd(high) === null) throw new Error('could not inflate pack object');
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (tryEnd(mid) !== null) high = mid;
    else low = mid;
  }
  const raw = tryEnd(high);
  if (raw === null) throw new Error('could not inflate pack object');
  return { raw, end: high };
}

/** Apply a git delta stream to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos];
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const chunks: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          offset |= delta[pos] << (bit * 8);
          pos += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          size |= delta[pos] << (bit * 8);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      chunks.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      chunks.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (produced !== targetSize) throw new Error('delta target size mismatch');
  return Buffer.concat(chunks);
}

/** Read a packfile into the store; returns the written oids in pack order. */
export function readPack(forge: Forge, pack: Buffer): string[] {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const actual = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(actual)) throw new Error('pack checksum mismatch');
  const written: string[] = [];
  const byOffset = new Map<number, string>();
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    const objectStart = pos;
    const header = readPackObjectHeader(pack, pos);
    pos = header.next;
    let type: string;
    let raw: Buffer;
    if (header.typeId === 6) {
      // OFS_DELTA: negative-offset varint, then the delta stream.
      let byte = pack[pos];
      pos += 1;
      let offset = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[pos];
        pos += 1;
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      const baseOffset = objectStart - offset;
      const baseOid = byOffset.get(baseOffset);
      if (!baseOid) throw new Error('OFS_DELTA base not in pack');
      const base = forge.getObject(baseOid);
      if (!base) throw new Error('OFS_DELTA base not in pack');
      const { raw: delta, end } = inflateBounded(pack, pos, header.size);
      pos = end;
      raw = applyDelta(base.data, delta);
      type = base.type;
    } else if (header.typeId === 7) {
      // REF_DELTA: 20-byte base oid, then the delta stream.
      const baseOid = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const base = forge.getObject(baseOid);
      if (!base) throw new Error(`delta base ${baseOid} unknown`);
      const { raw: delta, end } = inflateBounded(pack, pos, header.size);
      pos = end;
      raw = applyDelta(base.data, delta);
      type = base.type;
    } else {
      type = PACK_ID_TYPES[header.typeId] ?? '';
      if (type === '') throw new Error(`unknown pack object type ${header.typeId}`);
      const inflated = inflateBounded(pack, pos, header.size);
      pos = inflated.end;
      raw = inflated.raw;
      if (raw.length !== header.size) throw new Error('inflated size mismatch');
    }
    const oid = forge.putObject(type, raw);
    byOffset.set(objectStart, oid);
    written.push(oid);
  }
  return written;
}

// ---- ref helpers shared by the HTTP layer ---------------------------------

/** Peel a ref's oid to its commit, or null. */
export function refCommit(forge: Forge, repo: RepoRec, ref: string): string | null {
  const oid = repo.refs.get(ref);
  if (!oid) return null;
  return peelToCommit(forge, oid);
}

/** The peeled tip of a branch name, or null when the branch has no commit. */
export function branchTip(forge: Forge, repo: RepoRec, branch: string): string | null {
  return refCommit(forge, repo, `refs/heads/${branch}`);
}
