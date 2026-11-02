# AGENTS.md — Shared Rules for All AI Agents

This file is the authoritative rulebook for every AI coding agent operating in
this repository, including Claude Code and OpenAI Codex.

Agent-specific additions:
- Claude Code → [CLAUDE.md](CLAUDE.md)
- Workflow diagrams → [docs/AI_WORKFLOW.md](docs/AI_WORKFLOW.md)
- Security policy → [docs/SECURITY.md](docs/SECURITY.md)
- Privacy policy → [docs/PRIVACY.md](docs/PRIVACY.md)

---

## 1. Read Before Touching

Before editing any file:

1. Read `README.md` (if present) and any relevant file in `docs/`.
2. Read every file you plan to modify — understand its current state.
3. Run `git status` and `git diff` to see what is already in progress.
4. Identify whether another agent's branch is open for the same area.

---

## 2. Branch Discipline

| Rule | Requirement |
|------|-------------|
| Never work on `main` | All changes must be on a feature branch |
| One task = one branch | Never mix unrelated changes |
| Claude naming | `claude/<task-name>` |
| Codex naming | `codex/<task-name>` |
| Base branch | Always branch from current `main` unless instructed otherwise |

---

## 3. No Simultaneous Edits

Two AI agents must **never** write to the same working tree at the same time.

- Use separate branches.
- Use separate Git worktrees when parallelism is needed.
- Assign non-overlapping files before starting any parallel work.
- If overlap is discovered mid-task, stop and resolve before continuing.

---

## 4. Scope Discipline

- Modify only the files required for the current task.
- Do not fix unrelated issues in passing — log them and stop.
- Do not refactor, rename, or reorganize unless the task explicitly says so.
- If a required change touches an out-of-scope file, stop and report; do not proceed unilaterally.

---

## 5. Inspect Before and After

Always run:

```bash
git status
git diff
```

Before starting work — to understand the current state.
After completing work — to confirm only intended files changed.

---

## 6. Testing

- Run the relevant test suite before declaring any task complete.
- For this project: `npx vitest run` or a scoped subset.
- If no tests cover the changed area, state that explicitly in the completion report.
- Do not claim a task is complete if tests fail.

---

## 7. Absolute Security Prohibitions

Never commit any of the following, under any circumstances:

- `.env`, `.env.local`, `.env.*` files
- Supabase project URL or anon key
- Supabase service-role key (bypasses all Row Level Security)
- Any JWT, API token, or bearer token
- Passwords, private keys, certificates (`.pem`, `.key`)
- Personal information — real names, ages, ID numbers, phone numbers
- Family financial data — real asset values, balances, debt amounts
- Real tax scenarios or tax filing records
- Real property addresses

**If you encounter any of the above already in the repository, stop and report immediately. Do not proceed.**

See [docs/SECURITY.md](docs/SECURITY.md) for full policy and incident response.

---

## 8. Data Privacy

Use **synthetic demo data only** — generic names (홍길동, 김철수), round-number
amounts unconnected to real portfolios, and structurally different scenarios.

Real family planning data lives in Jun-OS-Vault, not in this repository.

See [docs/PRIVACY.md](docs/PRIVACY.md) for full policy.

---

## 9. Git History

- Do not rewrite, amend, or force-push shared history.
- Do not `git reset --hard` on any branch that has been pushed.
- Do not `git push --force` unless a human has explicitly approved it in writing.

---

## 10. Merge Policy

- Never merge to `main` without human review.
- Open a pull request. Do not self-merge.
- Label the PR with the originating agent: `agent: claude` or `agent: codex`.
- CI must pass before review is requested.

---

## 11. Completion Report

Every completed task must produce a report with:

| Field | Content |
|-------|---------|
| **Files changed** | Full list of every modified file |
| **Tests run** | Commands executed and pass/fail result |
| **Assumptions** | Anything assumed but not confirmed |
| **Risks** | Any uncertainty about correctness or side-effects |
| **Follow-up work** | Issues noticed but left unresolved |
