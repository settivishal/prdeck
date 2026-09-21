import type { EngineInterface, Register } from "claude-code";

type Sev = "high" | "med" | "low";
// ponytail: constants until someone asks for userConfig
const GUARD: "warn" | "deny" = "warn";
const PANE = "pr-security";

// ponytail: regex scan; swap in $.model when noise gets loud
const RULES: [string, RegExp, Sev][] = [
  ["secret", /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}/i, "high"],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/, "high"],
  ["eval", /\beval\s*\(|new Function\s*\(/, "high"],
  ["shell exec", /\b(exec|execSync|spawn)\s*\(|subprocess\.(call|run|Popen)\(.*shell\s*=\s*True|os\.system\(/, "high"],
  ["sql concat", /(SELECT|INSERT|UPDATE|DELETE)\b[^;\n]*(\+\s*\w|\$\{|%s|\.format\()/i, "high"],
  ["pickle/yaml", /pickle\.loads?\(|yaml\.load\((?!.*SafeLoader)/, "high"],
  ["innerHTML", /dangerouslySetInnerHTML|\.innerHTML\s*=/, "med"], // sec-ignore
  ["tls off", /rejectUnauthorized\s*:\s*false|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true/, "med"],
  ["chmod 777", /chmod\s+(-R\s+)?777|0o?777\b/, "med"], // sec-ignore
  ["http url", /['"]http:\/\/(?!localhost|127\.0\.0\.1)/, "low"],
];

// ponytail: fixed skip list; make it a userConfig field if someone asks
const SKIP = /(^|\/)(node_modules|dist|build|vendor|tests?|__tests__|\.git)\/|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum)$|\.(md|min\.js|map|snap|svg|lock)$/;

export type Finding = { file: string; line: number; rule: string; sev: Sev; text: string };
type State = { base: string; files: number; findings: Finding[]; error?: string; scanning: boolean; at: number; prev: number };

let state: State = { base: "?", files: 0, findings: [], scanning: false, at: 0, prev: 0 };
let ignored = new Set<string>();
let filter = "all";

// line-number free so the ignore survives edits above it
export const ignoreKey = (f: Finding) => `${f.file}:${f.rule}:${f.text}`;
const live = () => state.findings.filter(f => !ignored.has(ignoreKey(f)));
const SEV_COLOR: Record<Sev, string> = { high: "error", med: "warning", low: "text" };

export function scanText(file: string, text: string, startLine = 1): Finding[] {
  const out: Finding[] = [];
  text.split("\n").forEach((raw, i) => {
    if (raw.includes("sec-ignore")) return;
    for (const [rule, re, sev] of RULES) if (re.test(raw)) out.push({ file, line: startLine + i, rule, sev, text: raw.trim() });
  });
  return out;
}

export function scanDiff(diff: string): { files: number; findings: Finding[] } {
  const findings: Finding[] = [];
  const files = new Set<string>();
  let file = "", line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ b/")) { file = raw.slice(6); files.add(file); continue; }
    if (SKIP.test(file)) continue;
    if (raw.startsWith("@@")) { line = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0) - 1; continue; }
    if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
    line++;
    findings.push(...scanText(file, raw.slice(1), line));
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
  if (state.scanning) return;
  state.scanning = true;
  $.ui.invalidate("ui.render");
  try {
    const base = await pickBase($);
    const mb = await $.process.run(["git", "merge-base", base, "HEAD"]);
    if (mb.exitCode !== 0) throw new Error(mb.stderr.trim() || "merge-base failed");
    // working tree vs merge-base: staged, unstaged and committed changes alike
    const { stdout } = await $.process.run(["git", "diff", "--unified=0", mb.stdout.trim()]);
    const r = scanDiff(stdout);
    const untracked = (await $.process.run(["git", "ls-files", "--others", "--exclude-standard"])).stdout.split("\n").filter(f => f && !SKIP.test(f));
    for (const f of untracked) r.findings.push(...scanText(f, await $.fs.read(f)));
    state = { ...state, base, files: r.files + untracked.length, findings: r.findings, error: undefined };
  } catch (err) {
    const error = String((err as Error).message ?? err).split("\n")[0] ?? "";
    if (error !== state.error) $.ui.log(`pr-security-bar: ${error}`, { to: "debug" });
    state = { ...state, error };
  }
  state = { ...state, scanning: false, at: Date.now() };
  $.ui.invalidate("ui.render");
}

async function togglePane($: EngineInterface): Promise<void> {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE);
  if (isOpen) await $.ui.close({ id: PANE });
  else await $.ui.open({ id: PANE, title: "PR security", focus: true, closeOnEscape: true });
}

async function setIgnored($: EngineInterface, key: string | null, on: boolean): Promise<void> {
  if (key === null) ignored.clear();
  else if (on) ignored.add(key);
  else ignored.delete(key);
  await $.store.set("ignored", [...ignored]);
  $.ui.invalidate("ui.render");
}

function fillFix($: EngineInterface, f: Finding): void {
  void $.prompt.fill({ text: `Fix security finding [${f.rule}] at ${f.file}:${f.line}:\n${f.text}`, mode: "replace" });
}

function guard($: EngineInterface, id: string, file: string, text: string): { deny: string } | undefined {
  if (SKIP.test(file)) return;
  const hits = scanText(file, text);
  if (!hits.length) return;
  const h = hits[0]!;
  const msg = `⚠ pr-security: ${h.rule} at line ${h.line}${hits.length > 1 ? ` (+${hits.length - 1} more)` : ""}`;
  $.ui.notice(id, msg);
  return GUARD === "deny" ? { deny: msg } : undefined;
}

const sevCounts = (fs: Finding[]) => (["high", "med", "low"] as Sev[])
  .map(s => [s, fs.filter(f => f.sev === s).length] as const)
  .filter(([, n]) => n > 0);

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    ignored = new Set(((await $.store.get("ignored")) as string[] | undefined) ?? []);
    void scan($);
    $.clock.every(30_000, () => void scan($));
    return next(e);
  });
  on("turn.start", ($, e, next) => { state.prev = live().length; return next(e); });
  on("turn.complete", async ($, e, next) => { void scan($); return next(e); });

  on("tool.call", { tool: "Write" }, ($, e, next) => guard($, e.tool_use_id, e.file_path, e.content) ?? next(e));
  on("tool.call", { tool: "Edit" }, ($, e, next) => guard($, e.tool_use_id, e.file_path, e.new_string) ?? next(e));

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    if (e.props.hasSurvey) return next(e);
    const { Box, Text, Button } = $.ui.resolve(e);
    const fs = live();
    const n = fs.length;
    const color = state.error ? "warning" : n ? "error" : "success";
    const delta = n - state.prev;
    const counts = sevCounts(fs).map(([s, c]) => `${c} ${s}`).join(" · ") || "0 findings";
    const ago = state.at ? `${Math.round((Date.now() - state.at) / 1000)}s ago` : "";
    return (
      <Box gap={1}>
        <Text color={color} bold>{n ? "●" : "○"}</Text>
        <Text color={color} wrap="truncate">
          {state.error ? `PR security: ${state.error}` : `PR security  ${counts}  vs ${state.base} · ${state.files} files`}
        </Text>
        {delta > 0 ? <Text color="error" bold>{`(+${delta})`}</Text> : null}
        {state.scanning ? <Text dimColor>scanning…</Text> : <Text dimColor>{ago}</Text>}
        <Button key="details" plain dimColor hotkey="d" onPress={() => void togglePane($)}>details</Button>
        <Button key="rescan" plain dimColor hotkey="r" onPress={() => void scan($)}>rescan</Button>
      </Box>
    );
  });

  on("ui.render", { component: "Pane" }, ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    const els = $.ui.resolve(e);
    const { Box, Text, Button } = els;
    const Select = "Select" in els ? els.Select : null; // mobile has no Select
    const all = state.findings;
    const rules = [...new Set(all.map(f => f.rule))];
    const shown = live().filter(f => filter === "all" || f.rule === filter);
    const hidden = all.filter(f => ignored.has(ignoreKey(f)));
    const files = [...new Set(shown.map(f => f.file))];
    const w = e.props.bodyColumns;
    return (
      <Box flexDirection="column" width={w}>
        <Box gap={1}>
          {Select ? (
            <Select key="rule" label="rule" value={filter}
              options={[{ value: "all", label: "all" }, ...rules.map(r => ({ value: r, label: r }))]}
              onSelect={(v: string) => { filter = v; $.ui.invalidate("ui.render"); }} />
          ) : null}
          <Text dimColor>{`${shown.length} shown · ${hidden.length} ignored`}</Text>
        </Box>
        {files.map(file => (
          <Box key={file} flexDirection="column" marginTop={1}>
            <Text bold>{file}</Text>
            {shown.filter(f => f.file === file).map(f => {
              const k = ignoreKey(f);
              return (
                <Box key={k} gap={1}>
                  <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    <Text wrap="truncate">
                      <Text dimColor>{`L${f.line} `}</Text>
                      <Text color={SEV_COLOR[f.sev]}>{`[${f.sev}] `}</Text>
                      {`${f.rule}: ${f.text}`}
                    </Text>
                  </Box>
                  <Box flexShrink={0} gap={1}>
                    <Button key={`fix:${k}`} plain dimColor onPress={() => fillFix($, f)}>fix</Button>
                    <Button key={`ign:${k}`} plain dimColor onPress={() => void setIgnored($, k, true)}>ignore</Button>
                  </Box>
                </Box>
              );
            })}
          </Box>
        ))}
        {hidden.length ? (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor bold>{`ignored (${hidden.length})`}</Text>
            {hidden.map(f => {
              const k = ignoreKey(f);
              return (
                <Box key={`h:${k}`} gap={1}>
                  <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    <Text dimColor wrap="truncate">{`${f.file}:${f.line} ${f.rule}: ${f.text}`}</Text>
                  </Box>
                  <Box flexShrink={0}>
                    <Button key={`un:${k}`} plain dimColor onPress={() => void setIgnored($, k, false)}>unignore</Button>
                  </Box>
                </Box>
              );
            })}
          </Box>
        ) : null}
        <Box gap={2} marginTop={1}>
          <Button key="p-rescan" plain dimColor hotkey="r" onPress={() => void scan($)}>rescan</Button>
          <Button key="p-clear" plain dimColor hotkey="c" onPress={() => void setIgnored($, null, false)}>clear ignores</Button>
          <Text dimColor>Esc close</Text>
        </Box>
      </Box>
    );
  });
};
