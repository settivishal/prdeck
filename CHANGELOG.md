# Changelog

## 0.10.1 — 2026-09-21
- fix: the band composes with the plugins beneath (next(e)) so tamaclaude and others draw too

## 0.10.0 — 2026-09-21
- q on a PR and /prdeck qr <url> draw a scannable QR code in a pane

## 0.9.1 — 2026-09-21
- fix: strip hover rows threw h is not a function

## 0.9.0 — 2026-09-21
- strip cycles churn / ci runs / session timeline with 3
- Strip mode setting picks the start view

## 0.8.1 — 2026-09-21
- release script: scripts/release.sh does bump, changelog, checks, tag, release, update

## 0.8.0 — 2026-09-21
- `Security scanning` setting: off hides the security row, strip and pane and disables scan, guards and model context; PR feed stays.
- `hooks/config.ts` holds settings; CHANGELOG and GitHub releases per tag.

## 0.7.1 — 2026-09-21
- Base64 fallback in the raster packer for Node < 26 (CI was red).

## 0.7.0 — 2026-09-21
- Haiku triage of regex hits (high/med/low/false positive), cached; `Haiku triage` setting.
- Git guard: warn or deny `git commit` / `git push` with high findings open.
- Findings ride along as model context on the first message.
- PR pane: inline review threads, `l` comment on a line, `o` checkout, author avatar (kitty/Ghostty), merge streak.
- Heat strip is a treemap: width by churn, hot files first, totals, hover legend.

## 0.6.1 — 2026-09-20
- Confetti fires when the last change is removed; 1.5 s burst.

## 0.6.0 — 2026-09-20
- Heat strip under the security row, confetti on going clean, hover card on `⇄`, spinner for pending checks.

## 0.5.0 — 2026-09-20
- CI: validate + tests on push and PR.
- Friendly `gh` errors in the band; diff size guard (4000 lines); rules as data with `Extra rules file` setting.

## 0.4.0 — 2026-09-20
- `/config` settings: write guard mode, base branch, only my PRs, poll interval.

## 0.3.0 — 2026-09-20
- `g` ask Claude to review a PR; `/prdeck` command with hidden context for the model.

## 0.2.0 — 2026-09-20
- Renamed to prdeck. PR feed via `gh`, review pane (description, checks, diff, reviews), approve / request changes / comment / merge / close.

## 0.1.0 — 2026-09-20
- Security row: regex scan of the branch diff, write guard, findings pane with ignore.
