import type { EngineInterface, Register } from "claude-code";

// ponytail: regex scan of the branch diff; swap in $.model when noise gets loud
const RULES: [string, RegExp][] = [
  ["secret", /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}/i],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["eval", /\beval\s*\(|new Function\s*\(/],
  ["shell exec", /\b(exec|execSync|spawn)\s*\(|subprocess\.(call|run|Popen)\(.*shell\s*=\s*True|os\.system\(/],
  ["sql concat", /(SELECT|INSERT|UPDATE|DELETE)\b[^;\n]*(\+\s*\w|\$\{|%s|\.format\()/i],
  ["innerHTML", /dangerouslySetInnerHTML|\.innerHTML\s*=/],
  ["pickle/yaml", /pickle\.loads?\(|yaml\.load\((?!.*SafeLoader)/],
  ["http url", /['"]http:\/\/(?!localhost|127\.0\.0\.1)/],
  ["tls off", /rejectUnauthorized\s*:\s*false|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true/],
  ["chmod 777", /chmod\s+(-R\s+)?777|0o?777\b/],
];

type Finding = { file: string; line: number; rule: string; text: string };
type State = { base: string; files: number; findings: Finding[]; error?: string };

let state: State = { base: "?", files: 0, findings: [] };
let open = false;

export function scanDiff(diff: string): { files: number; findings: Finding[] } {
  const findings: Finding[] = [];
  const files = new Set<string>();
  let file = "", line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ b/")) { file = raw.slice(6); files.add(file); continue; }
    if (raw.startsWith("@@")) { line = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0) - 1; continue; }
    if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
    line++;
    const text = raw.slice(1);
    for (const [rule, re] of RULES) if (re.test(text)) findings.push({ file, line, rule, text: text.trim() });
  }
  return { files: files.size, findings };
}

async function pickBase($: EngineInterface): Promise<string> {
  for (const b of ["origin/main", "origin/master", "main", "master"]) {
    const { exitCode } = await $.process.run(["git", "rev-parse", "--verify", "-q", b]);
    if (exitCode === 0) return b;
  }
  throw new Error("no base branch");
}

async function scan($: EngineInterface): Promise<void> {
  try {
    const base = await pickBase($);
    const { stdout } = await $.process.run(["git", "diff", "--unified=0", `${base}...HEAD`]);
    state = { base, ...scanDiff(stdout) };
  } catch (err) {
    state = { ...state, error: String((err as Error).message ?? err) };
  }
  $.ui.invalidate("ui.render");
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    void scan($);
    $.clock.every(30_000, () => void scan($));
    return next(e);
  });
  on("turn.complete", async ($, e, next) => { void scan($); return next(e); });

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    if (e.props.hasSurvey) return next(e);
    const { Box, Text, Button } = $.ui.resolve(e);
    const n = state.findings.length;
    const color = state.error ? "warning" : n ? "error" : "success";
    const label = state.error
      ? `PR security: ${state.error}`
      : `PR security: ${state.files} files vs ${state.base} · ${n} finding${n === 1 ? "" : "s"}`;
    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text color={color} bold>{n ? "●" : "○"}</Text>
          <Text color={color} wrap="truncate">{label}</Text>
          <Button key="toggle" plain dimColor onPress={() => { open = !open; $.ui.invalidate("ui.render"); }}>
            {open ? "hide" : "details"}
          </Button>
          <Button key="rescan" plain dimColor onPress={() => void scan($)}>rescan</Button>
        </Box>
        {open && state.findings.map((f, i) => (
          <Text key={String(i)} wrap="truncate">{`  ${f.file}:${f.line} [${f.rule}] ${f.text}`}</Text>
        ))}
      </Box>
    );
  });
};
