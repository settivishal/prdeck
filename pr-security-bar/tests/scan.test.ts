import { scanDiff } from "../hooks/hooks.tsx";

const diff = `diff --git a/app.ts b/app.ts
--- a/app.ts
+++ b/app.ts
@@ -1,0 +10,3 @@
+const ok = 1;
+const API_KEY = "sk-live-abcdefghijklmnop";
+eval(userInput);
@@ -20,0 +40 @@
+db.query("SELECT * FROM users WHERE id = " + id);
`;
const { files, findings } = scanDiff(diff);
if (files !== 1) throw new Error(`files ${files}`);
const got = findings.map(f => `${f.line}:${f.rule}`).join(",");
const want = "11:secret,12:eval,40:sql concat";
if (got !== want) throw new Error(`got ${got}\nwant ${want}`);
console.log("ok");
