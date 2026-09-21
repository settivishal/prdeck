import { pack, heatStrip, confetti } from "../hooks/raster.ts";
const eq = (got: unknown, want: unknown, what: string) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}\n got  ${JSON.stringify(got)}\n want ${JSON.stringify(want)}`);
};
const b64len = (cells: number) => Math.ceil((cells * 12) / 3) * 4;
eq(pack([[0x2588, 0xff8800]]).length, b64len(1), "one cell is 12 bytes");
eq(heatStrip([{ lines: 5, hot: false }, { lines: 500, hot: true }], 10).length, b64len(2), "strip sized to files");
eq(heatStrip(Array.from({ length: 40 }, () => ({ lines: 1, hot: false })), 8).length, b64len(8), "strip buckets to columns");
eq(confetti(20, 0, 30) === confetti(20, 0, 30), true, "deterministic");
eq(confetti(20, 29, 30).length, b64len(20), "frame sized to columns");
console.log("ok");
