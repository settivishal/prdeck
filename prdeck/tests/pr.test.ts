import { parseDiff, capHunks, checkSummary } from "../hooks/pr.ts";
const eq = (got: unknown, want: unknown, what: string) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}\n got  ${JSON.stringify(got)}\n want ${JSON.stringify(want)}`);
};
const diff = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const a = 1;
+const b = 2;
 export {};
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
diff --git a/b.py b/b.py
new file mode 100644
--- /dev/null
+++ b/b.py
@@ -0,0 +1 @@
+print(1)
`;
const files = parseDiff(diff);
eq(files.map(f => f.file), ["src/a.ts", "b.py"], "files");
eq(files[0]!.hunks, "@@ -1,2 +1,3 @@\n const a = 1;\n+const b = 2;\n export {};", "hunks");
eq(files[1]!.hunks, "@@ -0,0 +1 @@\n+print(1)", "hunks 2");
const big = Array.from({ length: 100 }, (_, i) => `+line ${i}`).join("\n");
const c = capHunks(big, 200);
eq(c.source.length <= 200 && !c.source.endsWith("\n") && c.dropped > 0 && c.source.split("\n").length + c.dropped === 100, true, "cap");
eq(checkSummary([{ conclusion: "SUCCESS" }, { state: "FAILURE" }, { conclusion: "", state: "PENDING" }, { conclusion: "SKIPPED" }]), { ok: 2, fail: 1, pending: 1 }, "checks");
console.log("ok");
