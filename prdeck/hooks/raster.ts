// Raster cell packing and the two little pictures the band draws: a heat strip and confetti.
const DEFAULT = 0x01000000; // terminal's own colour
const BLOCK = 0x2588, SPACE = 0x20;

export type Cell = [cp: number, fg: number, bg?: number];

export function pack(cells: Cell[]): string {
  const words = new Uint32Array(cells.length * 3);
  cells.forEach(([cp, fg, bg], i) => { words[i * 3] = cp; words[i * 3 + 1] = fg; words[i * 3 + 2] = bg ?? DEFAULT; });
  return (new Uint8Array(words.buffer) as Uint8Array & { toBase64(): string }).toBase64();
}

// one cell per changed file: colour by churn, red when it holds a finding; buckets when files > columns
export function heatStrip(files: { lines: number; hot: boolean }[], columns: number): string {
  const n = Math.min(columns, files.length);
  const per = files.length / n;
  const cells: Cell[] = [];
  for (let i = 0; i < n; i++) {
    const bucket = files.slice(Math.floor(i * per), Math.max(Math.floor(i * per) + 1, Math.floor((i + 1) * per)));
    const lines = Math.max(...bucket.map(f => f.lines));
    const hot = bucket.some(f => f.hot);
    cells.push([BLOCK, hot ? 0xef4444 : lines < 20 ? 0x22c55e : lines < 100 ? 0xeab308 : 0xf97316]);
  }
  return pack(cells);
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
