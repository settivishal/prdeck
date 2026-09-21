import { qrMatrix, qrRaster } from "../hooks/qr.ts";
const eq = (got: unknown, want: unknown, what: string) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}\n got  ${JSON.stringify(got)}\n want ${JSON.stringify(want)}`);
};
const m = qrMatrix("https://github.com/settivishal/prdeck/pull/1")!;
eq(m.length, 29, "44 bytes -> version 3 (29 modules)");
// finder pattern top-left row 0 and dark module
eq(m[0]!.slice(0, 7), [true, true, true, true, true, true, true], "finder row");
eq(m[m.length - 8]![8], true, "dark module");
// decoded offline with zxing for every version boundary (see scratch); here: structure per version
for (const [len, size] of [[17, 21], [18, 25], [53, 29], [54, 33], [106, 37]] as const) eq(qrMatrix("a".repeat(len))!.length, size, `len ${len}`);
eq(qrMatrix("a".repeat(107)), null, "too long");
const r = qrRaster("https://x.y")!;
eq([r.columns, r.rows], [29, 15], "v1 + quiet zone in half blocks");
console.log("ok");
