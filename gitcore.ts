// gitcore.ts — a minimal, pure-stdlib git object store: sha1-addressed objects, packfile
// read/write (full objects out, delta objects in), commit-graph walks and tree-level merges.
// Everything is in memory; the forge (store.ts) owns persistence-shaped state on top of this.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const TYPE_IDS: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function oidOf(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`);
  hash.update(data);
  return hash.digest('hex');
}

export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  put(type: ObjType, data: Buffer): string {
    const oid = oidOf(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }
}

// --------------------------------------------------------------------------- commits & trees

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  raw: Buffer;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message, raw: data };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.toString('ascii', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree-entry sort key: directories compare as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree (recursively) into path -> {mode, oid}. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
  const tree = store.get(treeOid);
  if (!tree || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Build (and store) nested trees from a flat path -> {mode, oid} map; returns the root tree oid. */
export function buildTreeFromFiles(store: ObjectStore, files: Map<string, { mode: string; oid: string }>): string {
  interface Dir {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = dir.dirs.get(parts[i]);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(parts[i], next);
      }
      dir = next;
    }
    dir.files.set(parts[parts.length - 1], file);
  }
  const emit = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of dir.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: emit(sub) });
    return store.put('tree', buildTreeData(entries));
  };
  return emit(root);
}

/** The tree oid at a directory path inside a root tree ('' = the root itself), or null. */
export function subtreeAt(store: ObjectStore, rootTreeOid: string, dirPath: string): string | null {
  if (dirPath === '') return rootTreeOid;
  let current = rootTreeOid;
  for (const part of dirPath.split('/')) {
    const tree = store.get(current);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((e) => e.name === part && e.mode === '40000');
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

// --------------------------------------------------------------------------- commit graph

/** All commits reachable from `start` (inclusive), following parents. */
export function commitClosure(store: ObjectStore, starts: Iterable<string>, stopAt?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const start of starts) if (!seen.has(start)) { seen.add(start); queue.push(start); }
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (stopAt?.has(oid)) continue; // the boundary commit itself is held, but its parents are not traversed
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!seen.has(parent)) { seen.add(parent); queue.push(parent); }
    }
  }
  return seen;
}

export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  // BFS from the descendant with early exit: a fast-forward check usually finds the ancestor
  // within a generation or two, so never pay for the full closure.
  const seen = new Set<string>([descendant]);
  const queue = [descendant];
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head];
    head += 1;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) { seen.add(parent); queue.push(parent); }
    }
  }
  return false;
}

/** A best common ancestor of two commits (BFS by generation from both sides), or null. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsOfA = commitClosure(store, [a]);
  if (ancestorsOfA.has(b)) return b;
  if (commitClosure(store, [b]).has(a)) return a;
  // BFS from b, first commit that is also an ancestor of a wins (nearest by b's generations).
  const seen = new Set<string>([b]);
  let frontier = [b];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      const obj = store.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) {
        if (ancestorsOfA.has(parent)) return parent;
        if (!seen.has(parent)) { seen.add(parent); next.push(parent); }
      }
    }
    frontier = next;
  }
  return null;
}

/** Peel a tag (or any object) down to its commit; returns the commit oid or null. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const obj = store.get(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (!match) return null;
      current = match[1];
      continue;
    }
    return null;
  }
  return null;
}

/** Every object (commits, trees, blobs, tags) in the closure of the given commit set. */
export function objectClosure(store: ObjectStore, commits: ReadonlySet<string>, excludeCommits?: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const excluded = new Set<string>();
  const addTree = (treeOid: string, sink: Set<string>) => {
    if (sink.has(treeOid)) return;
    const tree = store.get(treeOid);
    if (!tree || tree.type !== 'tree') return;
    sink.add(treeOid);
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') addTree(entry.oid, sink);
      else sink.add(entry.oid);
    }
  };
  if (excludeCommits) {
    for (const oid of excludeCommits) {
      const obj = store.get(oid);
      if (obj?.type === 'commit') { excluded.add(oid); addTree(parseCommit(obj.data).tree, excluded); }
      else if (obj?.type === 'tag') excluded.add(oid);
    }
  }
  for (const oid of commits) {
    const obj = store.get(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'commit') addTree(parseCommit(obj.data).tree, out);
  }
  for (const oid of excluded) out.delete(oid);
  return out;
}

// --------------------------------------------------------------------------- tree merge (squash semantics)

/**
 * Three-way merge at tree level: for each path, if exactly one side changed it relative to the
 * base, take that side; if both changed it identically, take it; if both changed it differently,
 * the path conflicts. Returns the merged file map, or null with the conflicting paths filled in.
 */
export function mergeFileMaps(
  base: Map<string, { mode: string; oid: string }>,
  ours: Map<string, { mode: string; oid: string }>,
  theirs: Map<string, { mode: string; oid: string }>,
  conflicts: string[],
): Map<string, { mode: string; oid: string }> | null {
  const merged = new Map<string, { mode: string; oid: string }>();
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const sameOT = o?.oid === t?.oid && o?.mode === t?.mode;
    if (sameOT) { if (o) merged.set(path, o); continue; }
    const oursChanged = o?.oid !== b?.oid || o?.mode !== b?.mode;
    const theirsChanged = t?.oid !== b?.oid || t?.mode !== b?.mode;
    if (oursChanged && theirsChanged) { conflicts.push(path); continue; }
    if (theirsChanged) { if (t) merged.set(path, t); continue; }
    if (o) merged.set(path, o); // unchanged from base, or only ours changed (o === winner either way)
  }
  return conflicts.length > 0 ? null : merged;
}

// --------------------------------------------------------------------------- packfiles

function packObjectHeader(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_IDS[type] << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Serialize the given objects (full form, no deltas) into a packfile v2 buffer. */
export function writePack(store: ObjectStore, oids: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const obj = store.get(oid);
    if (!obj) throw new Error(`writePack: unknown object ${oid}`);
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    const byte = buf[pos];
    pos += 1;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: pos };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos];
      pos += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readSize();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let cpOffset = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { cpOffset += delta[pos] * 2 ** (8 * i); pos += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { cpSize += delta[pos] * 2 ** (8 * i); pos += 1; }
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOffset, cpOffset + cpSize));
      produced += cpSize;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

/**
 * Parse a packfile and store every object it carries (resolving OFS/REF deltas against the pack
 * itself or the store). Returns the object ids written, in pack order.
 */
export function readPack(store: ObjectStore, pack: Buffer): string[] {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');
  let pos = 12;
  const written: string[] = [];
  const local = new Map<number, string>(); // pack offset -> oid, for OFS_DELTA
  for (let i = 0; i < count; i += 1) {
    const start = pos;
    let byte = pack[pos];
    pos += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos];
      pos += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOid: string | null = null;
    if (typeId === 6) { // OFS_DELTA
      let back = pack[pos];
      pos += 1;
      let offset = back & 0x7f;
      while (back & 0x80) {
        back = pack[pos];
        pos += 1;
        offset = (offset + 1) * 128 + (back & 0x7f);
      }
      baseOid = local.get(start - offset) ?? null;
      if (baseOid === null) throw new Error('OFS_DELTA base not in pack');
    } else if (typeId === 7) { // REF_DELTA
      baseOid = pack.toString('hex', pos, pos + 20);
      pos += 20;
    }
    // Inflate exactly this object's stream: try progressively is overkill; inflateSync with a
    // generous slice works because zlib stops at the stream end — but it errors on trailing data
    // in some builds, so use the raw stream via a bounded attempt loop over end positions is
    // unreliable. Instead use inflateSync on the remainder: Node tolerates trailing bytes after
    // the final block by returning the data and ignoring the rest? It does not. We therefore
    // decompress through a manual window: binary-search is wasteful; use zlib's inflate with
    // `finishFlush` semantics through createInflate is async — so fall back to slicing at the
    // next object boundary found by trial: try the whole remainder first (common: last object).
    const data = inflateBounded(pack, pos, size);
    pos = data.next;
    let type: ObjType;
    let raw: Buffer;
    if (baseOid !== null) {
      const base = store.get(baseOid);
      if (!base) throw new Error(`delta base ${baseOid} unknown`);
      type = base.type;
      raw = applyDelta(base.data, data.data);
    } else {
      const resolved = ID_TYPES[typeId];
      if (!resolved) throw new Error(`unknown pack object type ${typeId}`);
      type = resolved;
      raw = data.data;
    }
    if (raw.length !== size && baseOid === null) throw new Error('inflated size mismatch');
    const oid = store.put(type, raw);
    local.set(start, oid);
    written.push(oid);
  }
  return written;
}

/**
 * Inflate one zlib stream starting at `pos` whose inflated size is known. Node's inflateSync
 * tolerates trailing bytes (it returns the first stream's output), so the stream's exact end is
 * the smallest slice end that inflates successfully — found by binary search.
 */
function inflateBounded(buf: Buffer, pos: number, expectedSize: number): { data: Buffer; next: number } {
  const limit = buf.length - 20; // pack trailer
  const attempt = (end: number): Buffer | null => {
    try {
      const data = inflateSync(buf.subarray(pos, end), { maxOutputLength: expectedSize + 1 });
      return data.length === expectedSize ? data : null;
    } catch {
      return null;
    }
  };
  const whole = attempt(limit);
  if (whole !== null) {
    // Binary search the smallest end that still inflates: that is the stream's true end.
    let lo = pos + 1;
    let hi = limit;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (attempt(mid) !== null) hi = mid;
      else lo = mid + 1;
    }
    const data = attempt(lo);
    if (data === null) throw new Error('could not inflate pack object');
    return { data, next: lo };
  }
  throw new Error('could not inflate pack object');
}
