// Built-in scan rules. Extra rules come from the `rulesFile` setting: a JSON array of
// { "name": "...", "pattern": "regex source", "flags": "i", "sev": "high" | "med" | "low" }.
export type Sev = "high" | "med" | "low";
export type Rule = { name: string; re: RegExp; sev: Sev };
export type RuleJson = { name: string; pattern: string; flags?: string; sev: Sev };

export const BUILTIN: RuleJson[] = [
  { name: "secret", pattern: "(api[_-]?key|secret|password|token)\\s*[:=]\\s*['\"][^'\"]{8,}", flags: "i", sev: "high" },
  { name: "private key", pattern: "-----BEGIN [A-Z ]*PRIVATE KEY-----", sev: "high" },
  { name: "eval", pattern: "\\beval\\s*\\(|new Function\\s*\\(", sev: "high" },
  { name: "shell exec", pattern: "\\b(exec|execSync|spawn)\\s*\\(|subprocess\\.(call|run|Popen)\\(.*shell\\s*=\\s*True|os\\.system\\(", sev: "high" },
  { name: "sql concat", pattern: "(SELECT|INSERT|UPDATE|DELETE)\\b[^;\\n]*(\\+\\s*\\w|\\$\\{|%s|\\.format\\()", flags: "i", sev: "high" },
  { name: "pickle/yaml", pattern: "pickle\\.loads?\\(|yaml\\.load\\((?!.*SafeLoader)", sev: "high" },
  { name: "innerHTML", pattern: "dangerouslySetInnerHTML|\\.innerHTML\\s*=", sev: "med" }, // sec-ignore
  { name: "tls off", pattern: "rejectUnauthorized\\s*:\\s*false|verify\\s*=\\s*False|InsecureSkipVerify\\s*:\\s*true", sev: "med" },
  { name: "chmod 777", pattern: "chmod\\s+(-R\\s+)?777|0o?777\\b", sev: "med" }, // sec-ignore
  { name: "http url", pattern: "['\"]http://(?!localhost|127\\.0\\.0\\.1)", sev: "low" },
];

// Compiles rule JSON; returns the good ones and a message per bad one.
export function compileRules(json: unknown): { rules: Rule[]; errors: string[] } {
  const rules: Rule[] = [], errors: string[] = [];
  if (!Array.isArray(json)) return { rules, errors: ["rules must be a JSON array"] };
  json.forEach((r: Partial<RuleJson>, i) => {
    const sev = (["high", "med", "low"] as const).find(s => s === r.sev);
    if (typeof r.name !== "string" || typeof r.pattern !== "string" || !sev) { errors.push(`rule ${i}: need name, pattern, sev`); return; }
    try { rules.push({ name: r.name, re: new RegExp(r.pattern, r.flags ?? ""), sev }); }
    catch (e) { errors.push(`rule "${r.name}": ${(e as Error).message}`); }
  });
  return { rules, errors };
}
