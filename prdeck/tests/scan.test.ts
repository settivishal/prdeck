import { scanDiff, scanText, ignoreKey } from "../hooks/hooks.tsx";

const eq = (got: unknown, want: unknown, what: string) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}\n got  ${JSON.stringify(got)}\n want ${JSON.stringify(want)}`);
};

const diff = `diff --git a/app.ts b/app.ts
--- a/app.ts
+++ b/app.ts
@@ -1,0 +10,3 @@
+const ok = 1;
+const API_KEY = "sk-live-abcdefghijklmnop";
+eval(userInput);
@@ -20,0 +40 @@
+db.query("SELECT * FROM users WHERE id = " + id);
@@ -50 +51 @@
-eval(removed);
+const clean = 2;
@@ -60 +61 @@
+fetch("http://x.y"); // sec-ignore
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
+see http://example.com
--- a/package-lock.json
+++ b/package-lock.json
@@ -1 +1 @@
+"resolved": "http://registry.npmjs.org/x"
--- a/tests/t.js
+++ b/tests/t.js
@@ -1 +1 @@
+eval(x)
`;
const { files, findings } = scanDiff(diff);
eq(files, 4, "files");
eq(findings.map(f => `${f.file}:${f.line}:${f.rule}:${f.sev}`),
   ["app.ts:11:secret:high", "app.ts:12:eval:high", "app.ts:40:sql concat:high"], "diff findings");

// guard: Write body, 1-based lines, severity tiers
const body = `import x\nel.innerHTML = s\nfetch("http://a.b")\nexec("ls " + p)\n`;
eq(scanText("w.js", body).map(f => `${f.line}:${f.rule}:${f.sev}`),
   ["2:innerHTML:med", "3:http url:low", "4:shell exec:high"], "scanText");
eq(scanText("w.js", "eval(x) // sec-ignore"), [], "sec-ignore");

// ignore key ignores line number
const a = scanText("f.js", "\n\neval(x)")[0]!, b = scanText("f.js", "eval(x)")[0]!;
eq(a.line !== b.line && ignoreKey(a) === ignoreKey(b), true, "ignoreKey stable");
console.log("ok");
