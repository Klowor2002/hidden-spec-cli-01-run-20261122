// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as [old, new] pairs, for the `R` output lines. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- sections 5-8: line matching, unified diffs, SEARCH/REPLACE, V4A ----------

interface FileDoc {
  br: string;
  lines: string[];
  final: boolean;
}

/** Split a file's text at its own line break (SPEC section 3). */
function splitFile(text: string): FileDoc {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

function spliceDoc(d: FileDoc, at: number, remove: number, insert: string[], final: boolean): FileDoc {
  return { br: d.br, lines: [...d.lines.slice(0, at), ...insert, ...d.lines.slice(at + remove)], final };
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trimEndWs(s);
  return trimWs(s);
}

/** Positions i where O matches the file's lines at the given tier, at or after `from`. */
function occsAt(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (at or after `from`), with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from: number, eof: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occsAt(lines, o, t, from).filter((p) => !eof || p + o.length === lines.length);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One body line of a hunk or chunk: context (in O and N), deleted (O only), added (N only). */
interface Op {
  kind: 'ctx' | 'del' | 'add';
  text: string;
}

const oldOf = (ops: Op[]): string[] => ops.filter((o) => o.kind !== 'add').map((o) => o.text);

/**
 * Build N's lines at a match: a context line is written as the file's own matched line, and at tier 2 every other
 * line is re-indented from O's first line's leading whitespace to the file's first matched line's.
 */
function applyOps(ops: Op[], fileLines: string[], at: number, tier: number): string[] {
  const first = ops.find((o) => o.kind !== 'add');
  const p = first === undefined ? '' : leadWs(first.text);
  const f = first === undefined || fileLines[at] === undefined ? '' : leadWs(fileLines[at]!);
  const out: string[] = [];
  let oi = 0;
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(fileLines[at + oi]!);
      oi += 1;
    } else if (op.kind === 'del') {
      oi += 1;
    } else {
      let t = op.text;
      if (tier === 2 && first !== undefined && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

// ---------- section 6: unified diffs ----------

interface Hunk {
  a: number;
  ops: Op[];
  /** a `\` line follows the hunk's last context or `+` line */
  noFinal: boolean;
  /** a `\` line follows the hunk's last `+` line */
  noFinalAdd: boolean;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseHunkBody(lines: string[], start: number, a: number): { hunk: Hunk; next: number } {
  const items: ({ t: 'op'; op: Op } | { t: 'bs' })[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      items.push({ t: 'op', op: { kind: 'ctx', text: '' } });
      j += 1;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      items.push({ t: 'op', op: { kind: 'ctx', text: l.slice(1) } });
      j += 1;
      continue;
    }
    if (c === '-') {
      items.push({ t: 'op', op: { kind: 'del', text: l.slice(1) } });
      j += 1;
      continue;
    }
    if (c === '+') {
      items.push({ t: 'op', op: { kind: 'add', text: l.slice(1) } });
      j += 1;
      continue;
    }
    if (c === '\\') {
      items.push({ t: 'bs' });
      j += 1;
      continue;
    }
    break;
  }
  while (items.length > 0) {
    const last = items[items.length - 1]!;
    if (last.t === 'op' && last.op.kind === 'ctx' && last.op.text === '') items.pop();
    else break;
  }
  const ops = items.filter((x): x is { t: 'op'; op: Op } => x.t === 'op').map((x) => x.op);
  let lastCtxAdd = -1;
  let lastAdd = -1;
  for (let k = 0; k < items.length; k += 1) {
    const it = items[k]!;
    if (it.t !== 'op') continue;
    if (it.op.kind === 'ctx' || it.op.kind === 'add') lastCtxAdd = k;
    if (it.op.kind === 'add') lastAdd = k;
  }
  const noFinal = lastCtxAdd >= 0 && items[lastCtxAdd + 1] !== undefined && items[lastCtxAdd + 1]!.t === 'bs';
  const noFinalAdd = lastAdd >= 0 && items[lastAdd + 1] !== undefined && items[lastAdd + 1]!.t === 'bs';
  return { hunk: { a, ops, noFinal, noFinalAdd }, next: j };
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  createFlag: boolean;
  deleteFlag: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `, up to the first tab, spaces removed, a/ or b/ prefix removed. */
function parsePatchPath(s: string): string | null {
  const t = s.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/')) return t.slice(2);
  if (t.startsWith('b/')) return t.slice(2);
  return t;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let headerHasPair = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const rest = l.slice('diff --git '.length);
      if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${i + 1}`);
      const sep = rest.indexOf(' b/', 2);
      if (sep < 0) throw new Exit2(`error: parse ${i + 1}`);
      const x = rest.slice(2, sep);
      const y = rest.slice(sep + 3);
      if (x === '' || y === '') throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: x, newPath: y, createFlag: false, deleteFlag: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      headerHasPair = false;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !headerHasPair) {
        cur.oldPath = parsePatchPath(l.slice(4));
        cur.newPath = parsePatchPath(lines[i + 1]!.slice(4));
        headerHasPair = true;
        i += 2;
        continue;
      }
      cur = { oldPath: parsePatchPath(l.slice(4)), newPath: parsePatchPath(lines[i + 1]!.slice(4)), createFlag: false, deleteFlag: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      headerHasPair = true;
      i += 2;
      continue;
    }
    if (l.startsWith('--- ') && cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
    if (l.startsWith('@@')) {
      const m = HUNK_HEAD.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const r = parseHunkBody(lines, i + 1, parseInt(m[1]!, 10));
      cur.hunks.push(r.hunk);
      inHeader = false;
      i = r.next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('rename from ') && !headerHasPair) cur.oldPath = l.slice('rename from '.length);
      else if (l.startsWith('rename to ') && !headerHasPair) cur.newPath = l.slice('rename to '.length);
      else if (l.startsWith('new file mode')) cur.createFlag = true;
      else if (l.startsWith('deleted file mode')) cur.deleteFlag = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections;
}

function applyHunk(doc: FileDoc, h: Hunk, d: number, strict: boolean, path: string): { doc: FileDoc; d: number } {
  const o = oldOf(h.ops);
  if (o.length === 0) {
    const at = Math.min(h.a + d, doc.lines.length);
    const ins = applyOps(h.ops, doc.lines, at, 0);
    const final = at === doc.lines.length ? !h.noFinal : doc.final;
    return { doc: spliceDoc(doc, at, 0, ins, final), d: d + ins.length };
  }
  const found = findTier(doc.lines, o, strict, 0, false);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.occ[0]!;
  for (const p of found.occ) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const ins = applyOps(h.ops, doc.lines, best, found.tier);
  const atEnd = best + o.length === doc.lines.length;
  const final = atEnd ? !h.noFinal : doc.final;
  return { doc: spliceDoc(doc, best, o.length, ins, final), d: d + ins.length - o.length };
}

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let doc = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const r = applyHunk(doc, h, d, strict, path);
    doc = r.doc;
    d = r.d;
  }
  return joinFile(doc);
}

function unifiedEdits(sections: Section[], strict: boolean): Edit[] {
  return sections.map((s) => (tree) => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    if (oldP === null && newP === null) return;
    const isCreate = oldP === null || s.createFlag;
    const isDelete = !isCreate && (newP === null || s.deleteFlag);
    if (isCreate) {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const adds: string[] = [];
      let noFinalAdd = false;
      for (const h of s.hunks) {
        for (const op of h.ops) if (op.kind === 'add') adds.push(op.text);
        if (h.ops.some((o) => o.kind === 'add')) noFinalAdd = h.noFinalAdd;
      }
      tree.now.set(p, adds.length === 0 ? '' : adds.join('\n') + (noFinalAdd ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== newP) {
      if (!safe(oldP!)) throw new Fail('unsafe', oldP!);
      if (!safe(newP!)) throw new Fail('unsafe', newP!);
      const before = tree.get(oldP!);
      if (before === null) throw new Fail('missing', oldP!);
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const out = applyHunks(before, s.hunks, strict, oldP!);
      tree.now.set(oldP!, null);
      tree.now.set(newP!, out);
      tree.moves.push([oldP!, newP!]);
      return;
    }
    const p = oldP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, s.hunks, strict, p));
  });
}

// ---------- section 7: SEARCH/REPLACE blocks ----------

interface SRBlock {
  path: string;
  old: string[];
  next: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const si = i;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j += 1;
    if (j >= lines.length) throw new Exit2(`error: parse ${si + 1}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k += 1;
    if (k >= lines.length) throw new Exit2(`error: parse ${si + 1}`);
    let path: string | null = null;
    for (let p = si - 1; p > prevEnd; p -= 1) {
      const t = lines[p]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${si + 1}`);
    blocks.push({ path, old: lines.slice(si + 1, j), next: lines.slice(j + 1, k) });
    prevPath = path;
    prevEnd = k;
    i = k + 1;
  }
  return blocks;
}

function srEdits(blocks: SRBlock[], strict: boolean): Edit[] {
  return blocks.map((b) => (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.next.length === 0 ? '' : `${b.next.join('\n')}\n`);
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const doc = splitFile(before);
    const found = findTier(doc.lines, b.old, strict, 0, false);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const ops: Op[] = [
      ...b.old.map((t): Op => ({ kind: 'del', text: t })),
      ...b.next.map((t): Op => ({ kind: 'add', text: t })),
    ];
    const ins = applyOps(ops, doc.lines, found.occ[0]!, found.tier);
    tree.now.set(b.path, joinFile(spliceDoc(doc, found.occ[0]!, b.old.length, ins, doc.final)));
  });
}

// ---------- section 8: V4A patches ----------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  ops: Op[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const raw: { kind: 'add' | 'delete' | 'update'; path: string; start: number; lines: { no: number; text: string }[] }[] = [];
  let cur: (typeof raw)[number] | null = null;
  for (let i = first + 1; i < last; i += 1) {
    const l = lines[i]!;
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice('*** Update File: '.length).trim();
    }
    if (kind !== null) {
      cur = { kind, path, start: i + 1, lines: [] };
      raw.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(l)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    cur.lines.push({ no: i + 1, text: l });
  }
  const out: VSection[] = [];
  for (const s of raw) {
    while (s.lines.length > 0 && blank(s.lines[s.lines.length - 1]!.text)) s.lines.pop();
    if (s.kind === 'add') {
      const addLines: string[] = [];
      for (const ln of s.lines) {
        if (ln.text === '') addLines.push('');
        else if (ln.text.startsWith('+')) addLines.push(ln.text.slice(1));
        else throw new Exit2(`error: parse ${ln.no}`);
      }
      out.push({ kind: 'add', path: s.path, addLines, moveTo: null, chunks: [] });
      continue;
    }
    if (s.kind === 'delete') {
      if (s.lines.length > 0) throw new Exit2(`error: parse ${s.lines[0]!.no}`);
      out.push({ kind: 'delete', path: s.path, addLines: [], moveTo: null, chunks: [] });
      continue;
    }
    let idx = 0;
    let moveTo: string | null = null;
    if (s.lines.length > 0 && s.lines[0]!.text.startsWith('*** Move to: ')) {
      moveTo = s.lines[0]!.text.slice('*** Move to: '.length).trim();
      idx = 1;
    }
    const chunks: VChunk[] = [];
    let chunk: VChunk | null = null;
    let seenChunk = false;
    for (; idx < s.lines.length; idx += 1) {
      const ln = s.lines[idx]!;
      const l = ln.text;
      if (l.startsWith('@@')) {
        if (chunk !== null) chunks.push(chunk);
        const anchor = l.slice(2).trim();
        chunk = { anchor: anchor === '' ? null : anchor, eof: false, ops: [] };
        seenChunk = true;
        continue;
      }
      if (l === '*** End of File') {
        if (chunk === null) throw new Exit2(`error: parse ${ln.no}`);
        chunk.eof = true;
        chunks.push(chunk);
        chunk = null;
        continue;
      }
      if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
        if (chunk === null) {
          if (seenChunk) throw new Exit2(`error: parse ${ln.no}`);
          chunk = { anchor: null, eof: false, ops: [] };
          seenChunk = true;
        }
        if (l === '') chunk.ops.push({ kind: 'ctx', text: '' });
        else if (l[0] === ' ') chunk.ops.push({ kind: 'ctx', text: l.slice(1) });
        else if (l[0] === '-') chunk.ops.push({ kind: 'del', text: l.slice(1) });
        else chunk.ops.push({ kind: 'add', text: l.slice(1) });
        continue;
      }
      throw new Exit2(`error: parse ${ln.no}`);
    }
    if (chunk !== null) chunks.push(chunk);
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${s.start}`);
    out.push({ kind: 'update', path: s.path, addLines: [], moveTo, chunks });
  }
  return out;
}

/** First line at or after `from` equal to the anchor at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i += 1) {
      if (normLine(lines[i]!, t) === normLine(anchor, t)) return i;
    }
  }
  return null;
}

function v4aEdits(sections: VSection[], strict: boolean): Edit[] {
  return sections.map((s) => (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.addLines.length === 0 ? '' : `${s.addLines.join('\n')}\n`);
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    let doc = splitFile(before);
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        const a = findAnchor(doc.lines, ch.anchor, strict, cursor);
        if (a === null) throw new Fail('no-match', s.path);
        cursor = a + 1;
      }
      const o = oldOf(ch.ops);
      if (o.length === 0) {
        const at = ch.eof ? doc.lines.length : cursor;
        const ins = applyOps(ch.ops, doc.lines, at, 0);
        doc = spliceDoc(doc, at, 0, ins, doc.final);
        cursor = at + ins.length;
        continue;
      }
      const found = findTier(doc.lines, o, strict, cursor, ch.eof);
      if (found === null) throw new Fail('no-match', s.path);
      const at = found.occ[0]!;
      const ins = applyOps(ch.ops, doc.lines, at, found.tier);
      doc = spliceDoc(doc, at, o.length, ins, doc.final);
      cursor = at + ins.length;
    }
    const out = joinFile(doc);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, out);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, out);
    }
  });
}

function parsePatch(kind: string, lines: string[], strict: boolean): Edit[] {
  if (kind === 'unified') return unifiedEdits(parseUnified(lines), strict);
  if (kind === 'search-replace') return srEdits(parseSearchReplace(lines), strict);
  if (kind === 'v4a') return v4aEdits(parseV4a(lines), strict);
  return [];
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : parsePatch(kind, lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const mvLen = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = mvLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      movedOld.add(o);
      movedNew.add(n);
    }
  }
  const changed = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const p of changed) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of changed) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
