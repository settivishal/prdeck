// Plugin settings, filled from plugin.json userConfig at register(). Shared by every module.
export type Guard = "warn" | "deny" | "off";
export type StripMode = "churn" | "ci" | "timeline";
export const STRIP_MODES: StripMode[] = ["churn", "ci", "timeline"];
export const cfg = { guard: "warn" as Guard, base: "", mine: true, pollSeconds: 60, rulesFile: "", triage: true, security: true, strip: "churn" as StripMode };

export function readConfig(options: Readonly<Record<string, unknown>>): void {
  Object.assign(cfg, {
    guard: (["warn", "deny", "off"] as const).find(g => g === options.guard) ?? "warn",
    base: typeof options.base === "string" ? options.base.trim() : "",
    mine: options.mine !== false,
    pollSeconds: Math.max(15, Number(options.pollSeconds) || 60),
    rulesFile: typeof options.rulesFile === "string" ? options.rulesFile.trim() : "",
    triage: options.triage !== false,
    security: options.security !== false,
    strip: STRIP_MODES.find(m => m === options.strip) ?? "churn",
  });
}
