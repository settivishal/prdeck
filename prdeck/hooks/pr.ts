// Pure helpers for the PR pane: no `$` here (the validator wants `$` only in hooks.tsx).

export type Check = { name?: string; context?: string; conclusion?: string; state?: string; status?: string };
export type Pr = {
  number: number; title: string; author: { login: string }; headRefName: string; baseRefName: string;
  isDraft: boolean; updatedAt: string; reviewDecision: string; statusCheckRollup: Check[];
  additions: number; deletions: number; changedFiles: number; url: string;
};
export type PrDetail = {
  body: string; mergeable: string; mergeStateStatus: string; statusCheckRollup: Check[];
  reviews: { author: { login: string }; state: string; body: string; submittedAt: string }[];
  comments: { author: { login: string }; body: string; createdAt: string }[];
  files: { path: string; additions: number; deletions: number }[];
};
export type DiffFile = { file: string; hunks: string };

export function parseDiff(text: string): DiffFile[] {
  const out: DiffFile[] = [];
  for (const chunk of text.split(/^(?=diff --git )/m)) {
    const m = /^diff --git a\/.+? b\/(.+)$/m.exec(chunk);
    if (!m || /^Binary files .* differ$/m.test(chunk)) continue;
    const at = chunk.indexOf("\n@@");
    if (at < 0) continue;
    out.push({ file: m[1]!, hunks: chunk.slice(at + 1).replace(/\n$/, "") });
  }
  return out;
}

// Code element takes at most 10000 chars; cut at a line boundary and say how much went
export function capHunks(hunks: string, max = 9500): { source: string; dropped: number } {
  if (hunks.length <= max) return { source: hunks, dropped: 0 };
  const cut = hunks.lastIndexOf("\n", max);
  const source = hunks.slice(0, cut > 0 ? cut : max);
  return { source, dropped: hunks.slice(source.length).split("\n").length - 1 };
}

export function checkSummary(rollup: Check[] | null | undefined): { ok: number; fail: number; pending: number } {
  const s = { ok: 0, fail: 0, pending: 0 };
  for (const c of rollup ?? []) {
    const v = (c.conclusion || c.state || "").toUpperCase();
    if (v === "SUCCESS" || v === "NEUTRAL" || v === "SKIPPED") s.ok++;
    else if (v === "FAILURE" || v === "ERROR" || v === "TIMED_OUT" || v === "CANCELLED" || v === "ACTION_REQUIRED") s.fail++;
    else s.pending++;
  }
  return s;
}

export const checkGlyphs = (rollup: Check[] | null | undefined): string => {
  const { ok, fail, pending } = checkSummary(rollup);
  return [ok && `✓${ok}`, fail && `✗${fail}`, pending && `●${pending}`].filter(Boolean).join(" ") || "no checks";
};

export const decision = (d: string): string =>
  ({ APPROVED: "approved", CHANGES_REQUESTED: "changes requested", REVIEW_REQUIRED: "review required" } as Record<string, string>)[d] ?? "no review";
