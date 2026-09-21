// Minimal QR encoder: byte mode, error correction L, versions 1-5 (up to 106 bytes), best of 8 masks.
// Enough for a URL; anything longer returns null. ISO 18004, nothing clever.
import { pack, type Cell } from "./raster.ts";

const CAP = [0, 17, 32, 53, 78, 106]; // max bytes per version at EC L
const DATA_CW = [0, 19, 34, 55, 80, 108]; // data codewords (single block at EC L)
const EC_CW = [0, 7, 10, 15, 20, 26];
const ALIGN = [0, 0, 18, 22, 26, 30]; // alignment centre for v2..v5

// GF(256) with 0x11d
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
const mul = (a: number, b: number) => (a && b) ? EXP[LOG[a]! + LOG[b]!]! : 0;

function ecBytes(data: number[], n: number): number[] {
  let gen = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(gen.length + 1).fill(0);
    gen.forEach((g, j) => { next[j] ^= g; next[j + 1] ^= mul(g, EXP[i]!); });
    gen = next;
  }
  const res = new Array(n).fill(0);
  for (const d of data) {
    const f = d ^ res.shift()!; res.push(0);
    if (f) gen.slice(1).forEach((g, j) => { res[j] ^= mul(g, f); });
  }
  return res;
}

function formatBits(mask: number): number { // EC L (01) + mask -> 5 bits, BCH(15,5), then the fixed XOR
  const d = 0b01000 | mask; let r = d << 10;
  for (let i = 14; i >= 10; i--) if (r >> i & 1) r ^= 0x537 << (i - 10);
  return ((d << 10) | r) ^ 0x5412;
}

export function qrMatrix(text: string): boolean[][] | null {
  const bytes = [...new TextEncoder().encode(text)];
  const v = CAP.findIndex((c, i) => i > 0 && bytes.length <= c);
  if (v < 1) return null;
  const size = 17 + 4 * v;

  // bit stream: mode 0100, count, bytes, terminator, pad
  const bits: number[] = [];
  const push = (val: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push(val >> i & 1); };
  push(4, 4); push(bytes.length, 8); bytes.forEach(b => push(b, 8));
  const total = DATA_CW[v]! * 8;
  push(0, Math.min(4, total - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let p = 0xec; data.length < DATA_CW[v]!; p ^= 0xfd) data.push(p);
  const cw = [...data, ...ecBytes(data, EC_CW[v]!)];

  const m: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));
  const fn: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false)); // function-module mask
  const set = (r: number, c: number, on: boolean) => { m[r]![c] = on; fn[r]![c] = true; };
  const finder = (r0: number, c0: number) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const on = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      set(rr, cc, on);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  if (v >= 2) {
    const a = ALIGN[v]!;
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) set(a + r, a + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
  }
  set(size - 8, 8, true); // dark module
  // reserve the format areas so data skips them; written per mask below
  for (let i = 0; i < 15; i++) { placeFormat(size, i, false, (r, c, b) => set(r, c, b)); }
  // data placement: zigzag column pairs, alternating upward / downward
  const order: [number, number][] = [];
  let up = true;
  for (let right = size - 1; right >= 1; right -= 2, up = !up) {
    if (right === 6) right = 5;
    for (let i = 0; i < size; i++) {
      const r = up ? size - 1 - i : i;
      for (const c of [right, right - 1]) if (!fn[r]![c]) order.push([r, c]);
    }
  }
  const stream = cw.flatMap(b => Array.from({ length: 8 }, (_, i) => b >> (7 - i) & 1));
  const MASKS: ((r: number, c: number) => boolean)[] = [
    (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (_, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0, (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
  ];
  let best: boolean[][] | null = null, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const g = m.map(row => [...row]);
    order.forEach(([r, c], i) => { g[r]![c] = ((stream[i] ?? 0) === 1) !== MASKS[mask]!(r, c); });
    const f = formatBits(mask);
    for (let i = 0; i < 15; i++) placeFormat(size, i, (f >> (14 - i) & 1) === 1, (r, c, b) => { g[r]![c] = b; });
    const score = penalty(g);
    if (score < bestScore) { bestScore = score; best = g; }
  }
  return best;
}

// format info, both copies; i counts from the most significant bit
function placeFormat(size: number, i: number, bit: boolean, set: (r: number, c: number, b: boolean) => void): void {
  if (i < 6) set(8, i, bit); else if (i < 8) set(8, i + 1, bit); else if (i === 8) set(7, 8, bit); else set(14 - i, 8, bit);
  if (i < 7) set(size - 1 - i, 8, bit); else set(8, size - 15 + i, bit);
}

// ISO 18004 mask penalty: runs, 2x2 blocks, finder-like patterns, dark balance
function penalty(g: boolean[][]): number {
  const n = g.length; let p = 0;
  const line = (get: (i: number, j: number) => boolean) => {
    for (let i = 0; i < n; i++) {
      let run = 1;
      for (let j = 1; j <= n; j++) {
        if (j < n && get(i, j) === get(i, j - 1)) run++;
        else { if (run >= 5) p += run - 2; run = 1; }
      }
      const bits = Array.from({ length: n }, (_, j) => get(i, j) ? 1 : 0).join("");
      for (const pat of ["10111010000", "00001011101"]) for (let k = bits.indexOf(pat); k >= 0; k = bits.indexOf(pat, k + 1)) p += 40;
    }
  };
  line((i, j) => g[i]![j]!); line((i, j) => g[j]![i]!);
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) {
    const v = g[r]![c]; if (g[r]![c + 1] === v && g[r + 1]![c] === v && g[r + 1]![c + 1] === v) p += 3;
  }
  const dark = g.flat().filter(Boolean).length;
  p += Math.floor(Math.abs(dark * 100 / (n * n) - 50) / 5) * 10;
  return p;
}

// two modules per cell with half blocks, four-module quiet zone, explicit black on white
export function qrRaster(text: string): { cells: string; columns: number; rows: number } | null {
  const m = qrMatrix(text);
  if (!m) return null;
  const q = 4, n = m.length + q * 2;
  const at = (r: number, c: number) => { const rr = r - q, cc = c - q; return rr >= 0 && cc >= 0 && rr < m.length && cc < m.length && m[rr]![cc]!; };
  const rows = Math.ceil(n / 2);
  const cells: Cell[] = [];
  const W = 0xffffff, B = 0x000000;
  for (let r = 0; r < rows; r++) for (let c = 0; c < n; c++) {
    const top = at(2 * r, c), bot = 2 * r + 1 < n ? at(2 * r + 1, c) : false;
    cells.push(top === bot ? [0x2588, top ? B : W, top ? B : W] : [0x2580, top ? B : W, bot ? B : W]); // █ or ▀ (fg top, bg bottom)
  }
  return { cells: pack(cells), columns: n, rows };
}
