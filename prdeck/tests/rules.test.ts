import { BUILTIN, compileRules } from "../hooks/rules.ts";
const eq = (got: unknown, want: unknown, what: string) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}\n got  ${JSON.stringify(got)}\n want ${JSON.stringify(want)}`);
};
eq(compileRules(BUILTIN).errors, [], "builtin compiles");
eq(compileRules(BUILTIN).rules.length, BUILTIN.length, "builtin count");
const r = compileRules([{ name: "todo", pattern: "TODO", sev: "low" }, { name: "bad", pattern: "(", sev: "high" }, { name: "x", pattern: "y", sev: "nope" }, 5]);
eq(r.rules.map(x => x.name), ["todo"], "good rule kept");
eq(r.errors.length, 3, "three bad rules reported");
eq(compileRules({}).errors, ["rules must be a JSON array"], "non-array");
console.log("ok");
