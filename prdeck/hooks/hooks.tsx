import type { EngineInterface, Register } from "claude-code";
import { parseDiff, capHunks, checkSummary, checkGlyphs, decision, type Pr, type PrDetail, type DiffFile, type ReviewComment } from "./pr.ts";
import { BUILTIN, compileRules, type Rule, type Sev } from "./rules.ts";
import { heatStrip, confetti, dotRow, DOT, SPIN } from "./raster.ts";
import { cfg, readConfig, STRIP_MODES, type StripMode } from "./config.ts";

const PANE = "pr-security";
// ponytail: regex scan; swap in $.model when noise gets loud
let RULES: Rule[] = compileRules(BUILTIN).rules;

// ponytail: fixed skip list; make it a userConfig field if someone asks
const SKIP = /(^|\/)(node_modules|dist|build|vendor|tests?|__tests__|\.git)\/|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum)$|\.(md|min\.js|map|snap|svg|lock)$/;

export type Finding = { file: string; line: number; rule: string; sev: Sev; text: string };
type State = { base: string; files: number; findings: Finding[]; error?: string; scanning: boolean; at: number; prev: number; churn: { file: string; add: number; del: number; lines: number }[]; fx: number };
const FX_FRAMES = 15; // 1.5 s of confetti at the 100 ms tick

let state: State = { base: "?", files: 0, findings: [], scanning: false, at: 0, prev: 0, churn: [], fx: 0 };
let spin = 0;
// strip modes: churn (treemap), ci (last runs on this branch), timeline (one cell per turn)
let stripMode: StripMode = "churn";
type Run = { conclusion: string | null; status: string; name: string };
let ci: { branch: string; runs: Run[] } = { branch: "", runs: [] };
type Turn = { edits: number; tests: number; aborted: boolean };
const turns: Turn[] = [];
let cur: Turn = { edits: 0, tests: 0, aborted: false };
let ignored = new Set<string>();
let filter = "all";

// line-number free so the ignore survives edits above it
export const ignoreKey = (f: Finding) => `${f.file}:${f.rule}:${f.text}`;
// haiku verdicts by finding key: fp drops the finding, else its severity wins over the rule's
type Verdict = { sev: Sev | "fp"; why: string };
let triage = new Map<string, Verdict>();
const verdict = (f: Finding): Finding | null => {
  const v = triage.get(ignoreKey(f));
  return !v ? f : v.sev === "fp" ? null : { ...f, sev: v.sev };
};
const live = () => state.findings.filter(f => !ignored.has(ignoreKey(f))).map(verdict).filter((f): f is Finding => f !== null);
let streak = 0;
const avatars = new Map<string, string>(); // login -> png path, fetched once per session
const SEV_COLOR: Record<Sev, string> = { high: "error", med: "warning", low: "text" };

export function scanText(file: string, text: string, startLine = 1): Finding[] {
  const out: Finding[] = [];
  text.split("\n").forEach((raw, i) => {
    if (raw.includes("sec-ignore")) return;
    for (const { name, re, sev } of RULES) if (re.test(raw)) out.push({ file, line: startLine + i, rule: name, sev, text: raw.trim() });
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
  for (const b of cfg.base ? [cfg.base] : ["origin/main", "origin/master", "main", "master"]) {
    const { exitCode } = await $.process.run(["git", "rev-parse", "--verify", "-q", b]);
    if (exitCode === 0) return b;
  }
  throw new Error("no base branch");
}

async function loadRules($: EngineInterface): Promise<void> {
  if (!cfg.rulesFile) return;
  try {
    const { rules, errors } = compileRules(JSON.parse(await $.fs.read(cfg.rulesFile)));
    RULES = [...compileRules(BUILTIN).rules, ...rules];
    for (const m of errors) $.ui.log(`prdeck rulesFile: ${m}`);
  } catch (err) {
    $.ui.log(`prdeck rulesFile: ${String((err as Error).message ?? err)}`);
  }
}

async function runTriage($: EngineInterface): Promise<void> {
  if (!cfg.triage) return;
  const todo = state.findings.filter(f => !triage.has(ignoreKey(f))).slice(0, 40);
  if (!todo.length) return;
  const list = todo.map((f, i) => `${i}. [${f.rule}] ${f.file}:${f.line}: ${f.text.slice(0, 200)}`).join("\n");
  try {
    const reply = await $.model.complete({
      model: "haiku", maxTokens: 2000,
      system: "You triage regex hits from a security scanner. Answer ONLY a JSON array of {\"i\":number,\"sev\":\"high\"|\"med\"|\"low\"|\"fp\",\"why\":string}. fp = not a real issue (test fixture, comment, safe usage, placeholder). why is at most 8 words.",
      prompt: list,
    });
    const arr = JSON.parse(reply.slice(reply.indexOf("["), reply.lastIndexOf("]") + 1)) as { i: number; sev: string; why: string }[];
    for (const v of arr) {
      const f = todo[v.i];
      const sev = (["high", "med", "low", "fp"] as const).find(x => x === v.sev);
      if (f && sev) triage.set(ignoreKey(f), { sev, why: String(v.why ?? "").slice(0, 60) });
    }
    if (triage.size > 500) triage = new Map([...triage].slice(-500));
    await $.store.set("triage", [...triage]);
    $.ui.invalidate("ui.render");
    $.ui.invalidate("prompt.context");
  } catch (err) {
    $.ui.log(`prdeck triage: ${String((err as Error).message ?? err).split("\n")[0]}`, { to: "debug" });
  }
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
    const numstat = await $.process.run(["git", "diff", "--numstat", mb.stdout.trim()]);
    const churn = numstat.stdout.split("\n").filter(Boolean).map(l => {
      const [a = "0", d = "0", ...rest] = l.split("\t");
      return { file: rest.join("\t"), add: Number(a) || 0, del: Number(d) || 0, lines: (Number(a) || 0) + (Number(d) || 0) };
    }).filter(f => !SKIP.test(f.file));
    const untracked = (await $.process.run(["git", "ls-files", "--others", "--exclude-standard"])).stdout.split("\n").filter(f => f && !SKIP.test(f));
    for (const f of untracked) r.findings.push(...scanText(f, await $.fs.read(f)));
    for (const f of untracked) { const n = (await $.fs.read(f)).split("\n").length; churn.push({ file: f, add: n, del: 0, lines: n }); }
    const wasDirty = live().length > 0;
    state = { ...state, base, files: r.files + untracked.length, findings: r.findings, churn, error: undefined };
    if (wasDirty && live().length === 0) state.fx = FX_FRAMES + Math.min(streak, 10) * 3; // just went clean: party, longer on a streak
    $.ui.invalidate("prompt.context");
    void runTriage($);
  } catch (err) {
    const error = String((err as Error).message ?? err).split("\n")[0] ?? "";
    if (error !== state.error) $.ui.log(`prdeck: ${error}`, { to: "debug" });
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
  if (!cfg.security || cfg.guard === "off" || SKIP.test(file)) return;
  const hits = scanText(file, text);
  if (!hits.length) return;
  const h = hits[0]!;
  const msg = `⚠ pr-security: ${h.rule} at line ${h.line}${hits.length > 1 ? ` (+${hits.length - 1} more)` : ""}`;
  $.ui.notice(id, msg);
  return cfg.guard === "deny" ? { deny: msg } : undefined;
}

// ---------- PR feed (gh) ----------
const PR_PANE = "prs";
const MAX_DIFF_LINES = 4000; // past this, gh pr diff runs into the timeout; show a hint instead
type PrState = {
  repo?: string; list: Pr[]; seen: Set<number>; error?: string; rawError?: string; busy?: string; diffNote?: string;
  selected?: number; detail?: PrDetail; diff?: DiffFile[]; diffText?: string; threads?: ReviewComment[]; fileIdx: number;
  tab: "info" | "diff" | "reviews"; compose?: "comment" | "changes" | "line"; mine: boolean; bodyChunks: number;
};
let pr: PrState = { list: [], seen: new Set(), fileIdx: 0, tab: "info", mine: true, bodyChunks: 1 };
const BODY_CHUNK = 6; // lines of description shown per "more"

async function gh($: EngineInterface, args: string[], timeoutMs = 30_000): Promise<string> {
  const r = await $.process.run(["gh", ...args], { timeoutMs });
  if (r.exitCode !== 0) throw new Error(r.stderr.trim().split("\n")[0] || `gh ${args[0]} failed`);
  return r.stdout;
}

async function fetchList($: EngineInterface): Promise<void> {
  try {
    if (!pr.repo) pr.repo = JSON.parse(await gh($, ["repo", "view", "--json", "nameWithOwner"])).nameWithOwner;
    const list: Pr[] = JSON.parse(await gh($, ["pr", "list", "--state", "open", "--limit", "30", ...(pr.mine ? ["--author", "@me"] : []), "--json",
      "number,title,author,headRefName,baseRefName,isDraft,updatedAt,reviewDecision,statusCheckRollup,additions,deletions,changedFiles,url"]));
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (pr.seen.size === 0 && pr.list.length === 0) { // first load: nothing is "new"
      const stored = (await $.store.get("pr-seen")) as number[] | undefined;
      pr.seen = new Set(stored ?? list.map(p => p.number));
    }
    for (const p of list) if (!pr.seen.has(p.number)) $.ui.toast(`New PR #${p.number}: ${p.title}`);
    pr = { ...pr, list, error: undefined };
    void fetchRuns($);
  } catch (err) {
    const raw = String((err as Error).message ?? err);
    const error = /no git remotes|not a git repository|could not determine/i.test(raw) ? "" // not a GitHub repo: no row
      : /auth login|not logged|gh auth/i.test(raw) ? "gh not logged in — run: gh auth login"
      : /ENOENT|not found|cannot start|No such file/i.test(raw) ? "gh not installed — https://cli.github.com"
      : raw.split("\n")[0] ?? "gh failed";
    if (raw !== pr.rawError) $.ui.log(`prdeck gh: ${raw}`, { to: "debug" });
    pr = { ...pr, error, rawError: raw, list: [] };
  }
  $.ui.invalidate("ui.render");
}

async function fetchRuns($: EngineInterface): Promise<void> {
  try {
    const branch = (await $.process.run(["git", "branch", "--show-current"])).stdout.trim();
    if (!branch) return;
    const runs: Run[] = JSON.parse(await gh($, ["run", "list", "--branch", branch, "--limit", "30", "--json", "conclusion,status,name"]));
    ci = { branch, runs: runs.reverse() }; // oldest first, newest at the right edge
  } catch { ci = { ...ci, runs: [] }; }
  $.ui.invalidate("ui.render");
}

async function markSeen($: EngineInterface): Promise<void> {
  for (const p of pr.list) pr.seen.add(p.number);
  await $.store.set("pr-seen", [...pr.seen]);
  $.ui.invalidate("ui.render");
}

async function fetchDetail($: EngineInterface, n: number): Promise<void> {
  pr = { ...pr, selected: n, busy: "loading", detail: undefined, diff: undefined, fileIdx: 0, tab: "info", compose: undefined, bodyChunks: 1 };
  $.ui.invalidate("ui.render");
  try {
    const p = pr.list.find(x => x.number === n);
    const lines = (p?.additions ?? 0) + (p?.deletions ?? 0);
    const tooBig = lines > MAX_DIFF_LINES;
    const [view, diffText, threads] = await Promise.all([
      gh($, ["pr", "view", String(n), "--json", "body,mergeable,mergeStateStatus,statusCheckRollup,reviews,comments,files,headRefOid"]),
      tooBig ? Promise.resolve("") : gh($, ["pr", "diff", String(n)], 60_000),
      gh($, ["api", `repos/${pr.repo}/pulls/${n}/comments`, "--paginate"]).then(t => JSON.parse(t) as ReviewComment[]).catch(() => [] as ReviewComment[]),
    ]);
    pr = { ...pr, detail: JSON.parse(view), diff: parseDiff(diffText), diffText, threads, busy: undefined,
      diffNote: tooBig ? `diff too large (${lines} lines) — run: gh pr diff ${n}` : undefined };
    if (p && !avatars.has(p.author.login)) void fetchAvatar($, p.author.login);
  } catch (err) {
    pr = { ...pr, busy: undefined, error: String((err as Error).message ?? err) };
  }
  $.ui.invalidate("ui.render");
}

async function fetchAvatar($: EngineInterface, login: string): Promise<void> {
  const file = `/tmp/prdeck-avatar-${login}.png`;
  const r = await $.process.run(["curl", "-sL", "-o", file, `https://github.com/${login}.png?size=64`]).catch(() => ({ exitCode: 1 }));
  if (r.exitCode === 0) { avatars.set(login, file); $.ui.invalidate("ui.render"); }
}

async function lineComment($: EngineInterface, n: number, path: string, spec: string): Promise<void> {
  const m = /^\s*(\d+)\s*[:\s]\s*(.+)$/s.exec(spec);
  if (!m || !pr.detail) { $.ui.toast("format: <line>: <comment>"); return; }
  try {
    await gh($, ["api", "-X", "POST", `repos/${pr.repo}/pulls/${n}/comments`, "-f", `body=${m[2]}`, "-f", `path=${path}`,
      "-F", `line=${m[1]}`, "-f", "side=RIGHT", "-f", `commit_id=${pr.detail.headRefOid}`]);
    $.ui.toast(`#${n}: comment on ${path}:${m[1]} posted`);
    await fetchDetail($, n);
  } catch (err) {
    $.ui.toast(`comment failed: ${String((err as Error).message ?? err)}`);
  }
}

async function checkout($: EngineInterface, n: number): Promise<void> {
  pr = { ...pr, busy: "checkout" };
  $.ui.invalidate("ui.render");
  try { await gh($, ["pr", "checkout", String(n)]); $.ui.toast(`checked out #${n}`); void scan($); }
  catch (err) { $.ui.toast(`checkout failed: ${String((err as Error).message ?? err)}`); }
  pr = { ...pr, busy: undefined };
  $.ui.invalidate("ui.render");
}

async function prAction($: EngineInterface, args: string[], label: string, confirm?: string): Promise<void> {
  const n = pr.selected;
  if (n === undefined) return;
  if (confirm) {
    const a = await $.ui.ask(confirm, [label, "Cancel"]).catch(() => "Cancel");
    if (a !== label) return;
  }
  pr = { ...pr, busy: label.toLowerCase(), compose: undefined };
  $.ui.invalidate("ui.render");
  try {
    await gh($, ["pr", ...args, String(n)]);
    if (label === "Merge") {
      const clean = !pr.diffText || scanDiff(pr.diffText).findings.length === 0;
      streak = clean ? streak + 1 : 0;
      await $.store.set("streak", streak);
      $.ui.toast(clean ? `#${n} merged clean — streak ${streak} 🔥` : `#${n} merged with findings — streak reset`);
    } else $.ui.toast(`#${n}: ${label} done`);
  } catch (err) {
    $.ui.toast(`#${n}: ${label} failed: ${String((err as Error).message ?? err)}`);
  }
  pr = { ...pr, busy: undefined };
  await fetchList($);
  if (pr.list.some(p => p.number === n)) await fetchDetail($, n);
  else pr = { ...pr, selected: undefined, detail: undefined, diff: undefined };
  $.ui.invalidate("ui.render");
}

async function togglePrPane($: EngineInterface): Promise<void> {
  const isOpen = (await $.ui.panes()).some(p => p.id === PR_PANE);
  if (isOpen) await $.ui.close({ id: PR_PANE });
  else { await $.ui.open({ id: PR_PANE, title: "Pull requests", focus: true, closeOnEscape: true }); void markSeen($); }
}

function fillReview($: EngineInterface, n: number, title: string): void {
  const sec = pr.diffText ? scanDiff(pr.diffText).findings : [];
  const notes = sec.length ? `\nprdeck flagged:\n${sec.map(f => `- ${f.file}:${f.line} [${f.rule}] ${f.text}`).join("\n")}` : "";
  void $.prompt.fill({ mode: "replace", text: `Review PR #${n} "${title}": run \`gh pr diff ${n}\`, check correctness and security, list findings with file:line, then say whether to approve.${notes}` });
}

// 4: /prdeck report: what the person sees, and the raw list only the model reads
function report(): { text: string; context: string[] } {
  const fs = cfg.security ? live() : [];
  const lines = cfg.security ? [`security: ${sevCounts(fs).map(([s, c]) => `${c} ${s}`).join(", ") || "clean"} (vs ${state.base})`] : [];
  for (const f of fs.slice(0, 15)) lines.push(`  ${f.file}:${f.line} [${f.sev}] ${f.rule}`);
  if (fs.length > 15) lines.push(`  … ${fs.length - 15} more`);
  lines.push(pr.repo ? `PRs (${pr.mine ? "mine" : "all"}): ${pr.list.length} open` : "PRs: no GitHub remote");
  for (const p of pr.list) lines.push(`  #${p.number} ${p.title}  ${p.headRefName}→${p.baseRefName}  ${checkGlyphs(p.statusCheckRollup)}  ${decision(p.reviewDecision)}`);
  const context = [
    `prdeck security findings (JSON): ${JSON.stringify(fs)}`,
    `prdeck open PRs (JSON): ${JSON.stringify(pr.list.map(p => ({ number: p.number, title: p.title, head: p.headRefName, base: p.baseRefName, url: p.url, review: p.reviewDecision })))}`,
  ];
  return { text: lines.join("\n"), context };
}

function setPr(patch: Partial<PrState>, $: EngineInterface): void {
  pr = { ...pr, ...patch };
  $.ui.invalidate("ui.render");
}

const sevCounts = (fs: Finding[]) => (["high", "med", "low"] as Sev[])
  .map(s => [s, fs.filter(f => f.sev === s).length] as const)
  .filter(([, n]) => n > 0);

export const register: Register = (on, options) => {
  readConfig(options);
  stripMode = cfg.strip;
  pr = { ...pr, mine: cfg.mine };
  on("session.start", async ($, e, next) => {
    ignored = new Set(((await $.store.get("ignored")) as string[] | undefined) ?? []);
    triage = new Map(((await $.store.get("triage")) as [string, Verdict][] | undefined) ?? []);
    streak = Number((await $.store.get("streak")) ?? 0) || 0;
    await $.command.register({ name: "prdeck", description: "Security findings and open PRs, with the raw lists handed to the model." });
    if (cfg.security) {
      await loadRules($);
      void scan($);
      $.clock.every(30_000, () => void scan($));
    }
    void fetchList($);
    let tick = 0;
    $.clock.every(100, () => { // pending-check spinner (every 2nd tick), confetti frames
      tick++;
      const pending = pr.list.some(p => checkSummary(p.statusCheckRollup).pending);
      if (pending && tick % 2 === 0) spin = (spin + 1) % SPIN.length;
      const animating = state.fx > 0;
      if (animating) state.fx--; // last frame paints at fx=0, then the strip comes back
      if ((pending && tick % 2 === 0) || animating) $.ui.invalidate("ui.render");
    });
    $.clock.every(cfg.pollSeconds * 1000, () => void fetchList($));
    return next(e);
  });
  on("command.run", { command: "prdeck" }, () => report());
  on("turn.start", ($, e, next) => { state.prev = live().length; cur = { edits: 0, tests: 0, aborted: false }; return next(e); });
  on("turn.complete", async ($, e, next) => {
    turns.push({ ...cur, aborted: e.isAborted || e.reason === "refusal" });
    if (turns.length > 200) turns.shift();
    if (cfg.security) void scan($);
    void fetchList($);
    return next(e);
  });

  on("tool.call", { tool: "Write" }, ($, e, next) => { cur.edits++; return guard($, e.tool_use_id, e.file_path, e.content) ?? next(e); });
  on("tool.call", { tool: "Edit" }, ($, e, next) => { cur.edits++; return guard($, e.tool_use_id, e.file_path, e.new_string) ?? next(e); });
  on("tool.call", { tool: "Bash" }, ($, e, next) => {
    if (/\b(pytest|jest|vitest|mocha|cargo test|go test|npm test|pnpm test|yarn test|bun test|tsx .*\.test\.)/.test(e.command)) cur.tests++;
    if (!cfg.security || cfg.guard === "off" || !/\bgit\s+(push|commit)\b/.test(e.command)) return next(e);
    const high = live().filter(f => f.sev === "high");
    if (!high.length) return next(e);
    const msg = `⚠ prdeck: ${high.length} high finding${high.length === 1 ? "" : "s"} open (${high[0]!.file}:${high[0]!.line} ${high[0]!.rule})`;
    $.ui.notice(e.tool_use_id, msg);
    return cfg.guard === "deny" ? { deny: msg } : next(e);
  });
  on("prompt.context", async ($, e, next) => {
    const fs = cfg.security ? live() : [];
    if (!fs.length) return next(e);
    const text = `prdeck security findings on this branch (do not add more; fix when touching these files):\n` +
      fs.slice(0, 30).map(f => `- ${f.file}:${f.line} [${f.sev}] ${f.rule}`).join("\n");
    return next({ ...e, blocks: [...e.blocks, { name: "prdeck", text }] });
  });

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    if (e.props.hasSurvey || e.surface !== "terminal") return next(e); // the band is terminal-only; narrows the table for Raster
    const { Box, Text, Button, Raster } = $.ui.resolve(e);
    const fs = live();
    const n = fs.length;
    const w = Math.max(1, e.props.bodyColumns - 2);
    const hotFiles = new Set(fs.map(f => f.file));
    const heat = state.churn.map(c => ({ lines: c.lines, hot: hotFiles.has(c.file) }));
    // one strip, three datasets; `3` cycles
    let cells: { cells: string; columns: number }, label: string, legend: string, hover: { key: string; text: string; color?: string }[] = [];
    const labelW = (t: string) => Math.max(1, w - t.length - 2);
    if (stripMode === "ci") {
      const runColor = (r: Run) => r.status !== "completed" ? DOT.pending : ["success", "neutral", "skipped"].includes(r.conclusion ?? "") ? DOT.ok : DOT.fail;
      const ok = ci.runs.filter(r => runColor(r) === DOT.ok).length, fail = ci.runs.filter(r => runColor(r) === DOT.fail).length, pend = ci.runs.length - ok - fail;
      label = ci.runs.length ? `ci ${ci.branch} · ${ok}✓ ${fail}✗${pend ? ` ${pend}●` : ""}` : `ci ${ci.branch || "?"} · no runs`;
      cells = dotRow(ci.runs.map(runColor), labelW(label));
      legend = "one cell per workflow run on this branch, newest right · green ok · red failed · yellow running";
      hover = ci.runs.slice(-5).reverse().map((r, i) => ({ key: `run:${i}`, text: `${r.name}: ${r.conclusion ?? r.status}`, color: runColor(r) === DOT.fail ? "error" : undefined }));
    } else if (stripMode === "timeline") {
      const all = [...turns, cur];
      const turnColor = (t: Turn) => t.aborted ? DOT.abort : t.tests ? DOT.test : t.edits ? DOT.edit : DOT.idle;
      const edits = turns.reduce((n, t) => n + t.edits, 0), tests = turns.reduce((n, t) => n + t.tests, 0);
      label = `turn ${turns.length + 1} · ${edits} edits · ${tests} test runs`;
      cells = dotRow(all.map(turnColor), labelW(label));
      legend = "one cell per turn · blue edited files · green ran tests · red aborted or refused · grey neither";
    } else {
      const totals = state.churn.reduce((t, c) => ({ add: t.add + c.add, del: t.del + c.del }), { add: 0, del: 0 });
      label = `${state.churn.length} files · +${totals.add}/−${totals.del}`;
      cells = heatStrip(heat, labelW(label));
      legend = "red finding · orange >100 lines · yellow >20 · green small · width ∝ churn";
      hover = state.churn.filter(c => hotFiles.has(c.file)).slice(0, 5).map(c => ({ key: `hot:${c.file}`, text: `${c.file}  +${c.add}/−${c.del}`, color: "error" }));
    }
    const strip = state.fx > 0
      ? <Raster key="fx" columns={w} rows={1} cells={confetti(w, FX_FRAMES - state.fx, FX_FRAMES)} />
      : cells.columns ? (
        <Box key="strip" flexDirection="column">
          <Box gap={2}>
            <Raster key="stripcells" columns={cells.columns} rows={1} cells={cells.cells} />
            <Text dimColor>{label}</Text>
          </Box>
          <Box display="none" hover={{ display: "flex" }} flexDirection="column">
            {hover.map(h => <Text key={h.key} color={h.color} wrap="truncate">{h.text}</Text>)}
            <Text dimColor>{legend}</Text>
          </Box>
        </Box>
      ) : null;
    const color = state.error ? "warning" : n ? "error" : "success";
    const delta = n - state.prev;
    const counts = sevCounts(fs).map(([s, c]) => `${c} ${s}`).join(" · ") || "0 findings";
    const newest = pr.list[0];
    const unseen = pr.list.filter(p => !pr.seen.has(p.number)).length;
    const prColor = pr.list.some(p => p.reviewDecision === "CHANGES_REQUESTED" || checkSummary(p.statusCheckRollup).fail) ? "error"
      : pr.list.some(p => p.isDraft || checkSummary(p.statusCheckRollup).pending) ? "warning" : "success";
    const prRow = pr.error ? (
      <Box gap={1}><Text color="warning" bold>⇄</Text><Text dimColor wrap="truncate">{`PRs: ${pr.error}`}</Text></Box>
    ) : !pr.repo ? null : (
      <Box key="prrow" flexDirection="column">
      <Box gap={1}>
        <Text color={prColor} bold>⇄</Text>
        <Text color={prColor} wrap="truncate">
          {newest
            ? `${pr.list.length} PR${pr.list.length === 1 ? "" : "s"} · #${newest.number} ${newest.title} · ${checkGlyphs(newest.statusCheckRollup).replace("●", SPIN[spin]!)} · ${decision(newest.reviewDecision)}`
            : "no open PRs"}
        </Text>
        {unseen > 0 ? <Text color="error" bold>{`(+${unseen} new)`}</Text> : null}
        <Button key="prs" plain dimColor hotkey="2" onPress={() => void togglePrPane($)}>PRs</Button>
      </Box>
      <Box display="none" hover={{ display: "flex" }} flexDirection="column" paddingLeft={2}>
        {pr.list.slice(0, 3).map(p => (
          <Text key={`hv:${p.number}`} dimColor wrap="truncate">{`#${p.number} ${p.title}  ${p.headRefName}→${p.baseRefName}  ${checkGlyphs(p.statusCheckRollup)}  ${decision(p.reviewDecision)}`}</Text>
        ))}
      </Box>
      </Box>
    );
    const secRows = !cfg.security ? null : (
      <Box flexDirection="column">
      <Box gap={1}>
        <Text color={color} bold>{n ? "●" : "○"}</Text>
        <Text color={color} wrap="truncate">
          {state.error ? `security: ${state.error}` : `security  ${counts}`}
        </Text>
        {delta > 0 ? <Text color="error" bold>{`(+${delta})`}</Text> : null}
        <Button key="details" plain dimColor hotkey="1" onPress={() => void togglePane($)}>details</Button>
        <Button key="strip-mode" plain dimColor hotkey="3" onPress={() => { stripMode = STRIP_MODES[(STRIP_MODES.indexOf(stripMode) + 1) % STRIP_MODES.length]!; $.ui.invalidate("ui.render"); }}>{stripMode}</Button>
      </Box>
      {strip ? <Box paddingLeft={2}>{strip}</Box> : null}
      </Box>
    );
    return <Box flexDirection="column">{secRows}{prRow}</Box>;
  });

  on("ui.render", { component: "Pane" }, ($, e, next) => {
    if (e.requestId !== PR_PANE) return next(e);
    const els = $.ui.resolve(e);
    const { Box, Text, Button, Markdown, Code } = els;
    const Input = "Input" in els ? els.Input : null; // mobile has no Input
    const w = e.props.bodyColumns;
    const busy = pr.busy ? <Text dimColor>{` ${pr.busy}…`}</Text> : null;
    const cur = pr.list.find(p => p.number === pr.selected);

    if (!cur) return (
      <Box flexDirection="column" width={w}>
        <Box gap={1}><Text bold>{`${pr.list.length} open · ${pr.mine ? "mine" : "all"}`}</Text>{busy}{pr.error ? <Text color="error">{pr.error}</Text> : null}</Box>
        {pr.list.map(p => (
          <Box key={`pr:${p.number}`} gap={1}>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text wrap="truncate" dimColor={p.isDraft}>
                <Text bold>{`#${p.number} `}</Text>{`${p.title} `}<Text color="cyan">{`${p.headRefName}→${p.baseRefName} `}</Text>
                <Text color={checkSummary(p.statusCheckRollup).fail ? "error" : "success"}>{checkGlyphs(p.statusCheckRollup)}</Text>
              </Text>
            </Box>
            <Box flexShrink={0}><Button key={`view:${p.number}`} plain dimColor onPress={() => void fetchDetail($, p.number)}>view</Button></Box>
          </Box>
        ))}
        <Box gap={2} marginTop={1}>
          <Button key="pr-refresh" plain dimColor hotkey="r" onPress={() => void fetchList($)}>refresh</Button>
          <Button key="pr-mine" plain dimColor hotkey="f" onPress={() => { pr = { ...pr, mine: !pr.mine }; void fetchList($); }}>{pr.mine ? "show all" : "show mine"}</Button>
          <Text dimColor>Esc close</Text>
        </Box>
      </Box>
    );

    const d = pr.detail;
    const file = pr.diff?.[pr.fileIdx];
    const cap = file ? capHunks(file.hunks) : undefined;
    const sec = pr.diffText ? scanDiff(pr.diffText).findings : [];
    const tab = (id: PrState["tab"], key: string, label: string) => (
      <Button key={`tab:${id}`} plain hotkey={key} dimColor={pr.tab !== id} onPress={() => setPr({ tab: id, compose: undefined }, $)}>{label}</Button>
    );
    return (
      <Box flexDirection="column" width={w}>
        <Box gap={1}>
          {"Image" in els && avatars.has(cur.author.login)
            ? <els.Image key="avatar" source={{ file: avatars.get(cur.author.login)!, format: "png" }} columns={4} rows={2} alt={`@${cur.author.login}`} />
            : null}
          <Text bold wrap="truncate">{`#${cur.number} ${cur.title}`}</Text>{busy}
          {streak > 0 ? <Text color="warning">{`🔥${streak}`}</Text> : null}
        </Box>
        <Text dimColor wrap="truncate">
<Text color="cyan" bold>{cur.headRefName}</Text>{" → "}<Text color="cyan" bold>{cur.baseRefName}</Text>{`  ${decision(cur.reviewDecision)}`}
          {d ? `  ${d.mergeable.toLowerCase()}` : ""}
          {sec.length ? <Text color="error">{`  sec: ${sec.length}`}</Text> : ""}
        </Text>
        <Box gap={2}>{tab("info", "i", "info")}{tab("diff", "d", "diff")}{tab("reviews", "v", "reviews")}
          <Button key="back" plain dimColor hotkey="b" onPress={() => setPr({ selected: undefined, detail: undefined, diff: undefined, compose: undefined }, $)}>back</Button>
        </Box>
        {!d ? <Text dimColor>loading…</Text> : pr.tab === "info" ? (
          <Box flexDirection="column" marginTop={1}>
            {(() => {
              const lines = (d.body?.trim() || "_no description_").split("\n");
              const shown = lines.slice(0, pr.bodyChunks * BODY_CHUNK);
              const left = lines.length - shown.length;
              return (
                <Box flexDirection="column">
                  <Markdown text={shown.join("\n")} />
                  {left > 0 || pr.bodyChunks > 1 ? (
                    <Box gap={2}>
                      {left > 0 ? <Button key="more" plain dimColor hotkey="e" onPress={() => setPr({ bodyChunks: pr.bodyChunks + 1 }, $)}>{`more (${left} lines)`}</Button> : null}
                      {pr.bodyChunks > 1 ? <Button key="less" plain dimColor hotkey="w" onPress={() => setPr({ bodyChunks: 1 }, $)}>less</Button> : null}
                    </Box>
                  ) : null}
                </Box>
              );
            })()}
            <Text bold>checks</Text>
            {(d.statusCheckRollup ?? []).map((c, i) => {
              const v = (c.conclusion || c.state || "pending").toLowerCase();
              const col = ["success", "neutral", "skipped"].includes(v) ? "success" : ["failure", "error", "timed_out", "cancelled"].includes(v) ? "error" : "warning";
              return <Text key={`c:${i}`} color={col} wrap="truncate">{`  ${c.name || c.context || "?"}: ${v}`}</Text>;
            })}
          </Box>
        ) : pr.tab === "diff" ? (
          <Box flexDirection="column" marginTop={1}>
            <Box gap={1}>
              <Button key="prev" plain dimColor hotkey="k" onPress={() => setPr({ fileIdx: Math.max(0, pr.fileIdx - 1) }, $)}>‹</Button>
              <Text wrap="truncate">{file ? `${pr.fileIdx + 1}/${pr.diff!.length} ${file.file}` : pr.diffNote ?? "no diff"}</Text>
              <Button key="next" plain dimColor hotkey="j" onPress={() => setPr({ fileIdx: Math.min((pr.diff?.length ?? 1) - 1, pr.fileIdx + 1) }, $)}>›</Button>
            </Box>
            {file ? <Button key="linecomment" plain dimColor hotkey="l" onPress={() => setPr({ compose: "line" }, $)}>comment on line</Button> : null}
            {cap ? <Code format="diff" path={file!.file} source={cap.source} wrap="truncate-end" /> : null}
            {cap?.dropped ? <Text dimColor>{`… truncated, ${cap.dropped} more lines`}</Text> : null}
          </Box>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {d.reviews.length + d.comments.length + (pr.threads?.length ?? 0) === 0 ? <Text dimColor>none</Text> : null}
            {(pr.threads ?? []).map((t, i) => (
              <Box key={`t:${i}`} flexDirection="column">
                <Text bold>{`@${t.user.login} `}<Text color="cyan">{`${t.path}${t.line ? `:${t.line}` : ""}`}</Text></Text>
                <Markdown text={t.body} />
              </Box>
            ))}
            {d.reviews.map((r, i) => (
              <Box key={`r:${i}`} flexDirection="column">
                <Text bold>{`@${r.author.login} ${r.state.toLowerCase()} `}<Text dimColor>{r.submittedAt.slice(0, 10)}</Text></Text>
                {r.body?.trim() ? <Markdown text={r.body} /> : null}
              </Box>
            ))}
            {d.comments.map((c, i) => (
              <Box key={`m:${i}`} flexDirection="column">
                <Text bold>{`@${c.author.login} `}<Text dimColor>{c.createdAt.slice(0, 10)}</Text></Text>
                <Markdown text={c.body} />
              </Box>
            ))}
          </Box>
        )}
        {pr.compose === "line" && Input && file ? (
          <Input key="line" label={`${file.file} <line>: <comment>`} autoFocus
            onSubmit={(v: string) => { setPr({ compose: undefined }, $); void lineComment($, cur.number, file.file, v); }} />
        ) : null}
        {pr.compose && pr.compose !== "line" && Input ? (
          <Input key="body" label={pr.compose === "changes" ? "request changes" : "comment"} autoFocus
            onSubmit={(v: string) => void prAction($, ["review", pr.compose === "changes" ? "--request-changes" : "--comment", "-b", v], pr.compose === "changes" ? "Request changes" : "Comment")} />
        ) : null}
        <Box gap={2} marginTop={1}>
          <Button key="claude" plain dimColor hotkey="g" onPress={() => fillReview($, cur.number, cur.title)}>ask claude</Button>
          <Button key="checkout" plain dimColor hotkey="o" onPress={() => void checkout($, cur.number)}>checkout</Button>
          <Button key="approve" plain dimColor hotkey="a" onPress={() => void prAction($, ["review", "--approve"], "Approve")}>approve</Button>
          <Button key="changes" plain dimColor hotkey="x" onPress={() => setPr({ compose: "changes" }, $)}>request changes</Button>
          <Button key="comment" plain dimColor hotkey="c" onPress={() => setPr({ compose: "comment" }, $)}>comment</Button>
          <Button key="merge" plain dimColor hotkey="m" onPress={() => void prAction($, ["merge", "--squash"], "Merge", `Squash-merge #${cur.number} into ${cur.baseRefName}?`)}>merge</Button>
          <Button key="close" plain dimColor hotkey="z" onPress={() => void prAction($, ["close"], "Close", `Close #${cur.number} without merging?`)}>close</Button>
        </Box>
      </Box>
    );
  });

  on("ui.render", { component: "Pane" }, ($, e, next) => {
    if (e.requestId !== PANE || !cfg.security) return next(e);
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
                      {triage.get(k)?.why ? <Text dimColor>{`  — ${triage.get(k)!.why}`}</Text> : null}
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
