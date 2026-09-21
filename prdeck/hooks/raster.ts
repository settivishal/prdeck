// Raster cell packing and the two little pictures the band draws: a heat strip and confetti.
const DEFAULT = 0x01000000; // terminal's own colour
const BLOCK = 0x2588, SPACE = 0x20;

export type Cell = [cp: number, fg: number, bg?: number];

export function pack(cells: Cell[]): string {
  const words = new Uint32Array(cells.length * 3);
  cells.forEach(([cp, fg, bg], i) => { words[i * 3] = cp; words[i * 3 + 1] = fg; words[i * 3 + 2] = bg ?? DEFAULT; });
  return b64(new Uint8Array(words.buffer));
}

// Uint8Array.toBase64 is Node 26+; the plugin runtime has it, CI's Node may not
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (native) return native.call(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = bytes[i + 1], c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + (b === undefined ? "=" : B64[(n >> 6) & 63]!) + (c === undefined ? "=" : B64[n & 63]!);
  }
  return out;
}

export type HeatFile = { lines: number; hot: boolean };
const churnColor = (lines: number, hot: boolean) => hot ? 0xef4444 : lines < 20 ? 0x22c55e : lines < 100 ? 0xeab308 : 0xf97316;

// A treemap strip: hot files first, then by churn; each file's width is proportional to its
// lines changed (at least one cell); a blank separator between files when there is room.
export function heatStrip(files: HeatFile[], columns: number): { cells: string; columns: number } {
  const sorted = [...files].sort((a, b) => Number(b.hot) - Number(a.hot) || b.lines - a.lines);
  const n = Math.min(sorted.length, columns);
  const shown = sorted.slice(0, n);
  const gaps = n * 2 - 1 <= columns ? n - 1 : 0;
  const room = columns - gaps;
  const total = shown.reduce((s, f) => s + Math.max(1, f.lines), 0) || 1;
  // proportional widths, min 1, then trim the widest until it fits
  const widths = shown.map(f => Math.max(1, Math.round((Math.max(1, f.lines) / total) * room)));
  while (widths.reduce((a, b) => a + b, 0) > room) widths[widths.indexOf(Math.max(...widths))]!--;
  const cells: Cell[] = [];
  shown.forEach((f, i) => {
    if (i && gaps) cells.push([SPACE, DEFAULT]);
    for (let k = 0; k < widths[i]!; k++) cells.push([BLOCK, churnColor(f.lines, f.hot)]);
  });
  return { cells: pack(cells), columns: cells.length };
}

const CONFETTI = [0xef4444, 0xf97316, 0xeab308, 0x22c55e, 0x3b82f6, 0xa855f7, 0xec4899];
const GLYPHS = [0x2022, 0x2736, 0x25cf, 0x2731, 0x25a0, 0x2666]; // • ✶ ● ✱ ■ ♦

// frame t of a 1-row burst: density fades as t grows; deterministic so tests can pin it
export function confetti(columns: number, t: number, frames: number): string {
  const cells: Cell[] = [];
  let seed = t * 7919 + 17;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const density = 0.6 * (1 - t / frames);
  for (let i = 0; i < columns; i++) {
    cells.push(rnd() < density ? [GLYPHS[Math.floor(rnd() * GLYPHS.length)]!, CONFETTI[Math.floor(rnd() * CONFETTI.length)]!] : [SPACE, DEFAULT]);
  }
  return pack(cells);
}

export const SPIN = ["◐", "◓", "◑", "◒"];
