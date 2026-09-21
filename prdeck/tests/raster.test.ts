import { pack, heatStrip, confetti } from "../hooks/raster.ts";
const eq = (got: unknown, want: unknown, what: string) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}\n got  ${JSON.stringify(got)}\n want ${JSON.stringify(want)}`);
};
const b64len = (cells: number) => Math.ceil((cells * 12) / 3) * 4;
eq(pack([[0x2588, 0xff8800]]).length, b64len(1), "one cell is 12 bytes");
const s1 = heatStrip([{ lines: 5, hot: false }, { lines: 500, hot: true }], 20);
eq(s1.columns <= 20 && s1.cells.length === b64len(s1.columns), true, "strip fits width");
eq(s1.columns, 20, "proportional widths fill the room");
eq(heatStrip(Array.from({ length: 40 }, () => ({ lines: 1, hot: false })), 8).columns, 8, "more files than columns: clipped");
eq(heatStrip([], 10).columns, 0, "no files");
eq(confetti(20, 0, 30) === confetti(20, 0, 30), true, "deterministic");
eq(confetti(20, 29, 30).length, b64len(20), "frame sized to columns");
console.log("ok");
