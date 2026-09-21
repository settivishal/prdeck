# prdeck

PRs and security findings above the Claude Code prompt. No browser tab.

```
● security  5 high · 1 low  (+1)   1: details
⇄ 2 PRs · #42 fix login · ✓4 ✗1 · changes requested  (+1 new)   2: PRs
```

- **Security row**: regex scan of your branch vs merge-base (secrets, eval, shell exec, SQL concat, TLS off, ...). Warns in the permission dialog when Claude is about to write a hit. `1` opens the findings pane: filter, `fix` (fills the prompt), `ignore`.
- **PR row**: open PRs via `gh`. Toast on new ones. `2` opens the pane: description, checks, diff, reviews; approve / request changes / comment / merge / close.

## Install

```
claude plugin marketplace add settivishal/prdeck
claude plugin install prdeck@prdeck
```

Needs `gh` logged in for the PR row. Claude Code 2.1.278+ (function-hook plugins, early access).

## Dev

```
claude --plugin-dir ./prdeck
claude plugin validate ./prdeck
npx tsx prdeck/tests/scan.test.ts && npx tsx prdeck/tests/pr.test.ts
```
