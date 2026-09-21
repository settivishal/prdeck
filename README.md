# prdeck

A Claude Code mod that puts your pull requests and security findings above the prompt. Review, approve, merge — without leaving the terminal.

```
● security  2 high · 1 low  (+1)                        1: details
  ██████████████                     ← heat strip: one cell per changed file
⇄ 3 PRs · #42 fix login · ✓4 ◐1 · changes requested  (+1 new)   2: PRs
```

## Install

```
claude plugin marketplace add settivishal/prdeck
claude plugin install prdeck@prdeck
```

Requires Claude Code 2.1.278+ and, for the PR row, [`gh`](https://cli.github.com) logged in (`gh auth login`). Repos without a GitHub remote get the security row only.

## What it does

**Security row** — scans your branch against its base (merge-base, working tree and untracked files included) for secrets, private keys, `eval`, shell exec, SQL string concat, unsafe deserialization, `innerHTML`, TLS verification off, `chmod 777`, plain `http://`. Colour is the worst severity; `(+N)` means the last turn added findings.

**Heat strip** — one cell per changed file, green → yellow → orange by churn, red where a finding sits. When your branch goes from findings to clean: one second of confetti. Pending checks spin. Hover `⇄` (fullscreen terminal) to peek at the top three PRs without opening the pane.

**Write guard** — when Claude is about to `Write` or `Edit` a line that hits a rule, the permission dialog shows `⚠ prdeck: eval at line 3`. Set it to `deny` to block the call outright.

**PR row** — open PRs from `gh`, newest first, with check status and review decision. Toast when a new PR appears.

**Panes** — press the digit with an empty prompt:

| key | pane | inside |
|---|---|---|
| `1` | findings | filter by rule · `fix` fills the prompt · `ignore` / `unignore` (persisted) · `r` rescan · `c` clear ignores |
| `2` | pull requests | `view` a PR → `i` info (description, checks) · `d` diff (`j`/`k` files) · `v` reviews · `g` ask Claude to review · `a` approve · `x` request changes · `c` comment · `m` merge · `z` close · `f` mine/all · `b` back |

Merge and close ask for confirmation first.

**`/prdeck`** — prints findings and open PRs, and hands the model the raw lists as context. Follow with "fix the high ones" or "summarise PR #42".

**Big PRs** — past 4000 changed lines the diff tab shows a hint instead of fetching (`gh pr diff N`); info and reviews still load.

**Inline ignore** — a line containing `sec-ignore` is never flagged.

## Configure

`/config` → prdeck:

| setting | default | |
|---|---|---|
| Write/Edit guard | `warn` | `warn` · `deny` · `off` |
| Base branch | auto | `origin/main`, `origin/master`, `main`, `master` in that order |
| Only my PRs | on | off lists every open PR |
| PR poll interval | 60 s | minimum 15 |
| Extra rules file | — | path to a JSON array: `[{ "name": "todo", "pattern": "TODO", "flags": "i", "sev": "low" }]`, merged with the built-ins |

## How it works

One hooks module, no daemon, no tokens. `git` and `gh` run as you through Claude Code's process API; the scan is regex over the diff; the UI is drawn by Claude Code's own render hooks (`AbovePrompt`, `Pane`). Nothing leaves your machine except what `gh` sends to GitHub when you press an action.

## License

MIT
