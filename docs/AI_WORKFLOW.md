# AI Workflow — Claude Code + OpenAI Codex Collaboration

This document defines how Claude Code and OpenAI Codex work together safely
on the KYN repository without conflicting with each other.

All agents must also follow [../AGENTS.md](../AGENTS.md).

---

## A. Claude Implements, Codex Reviews

```
1. Human assigns task to Claude
2. Claude branches: git checkout -b claude/<task-name>
3. Claude implements and runs tests
4. Claude opens pull request (label: agent: claude)
5. Claude posts completion report in PR description
6. Codex reviews: logic, edge cases, security, tax accuracy
7. Human reads both views and approves or requests changes
8. Human merges (squash preferred)
9. Branch deleted
```

---

## B. Codex Implements, Claude Reviews

```
1. Human assigns task to Codex
2. Codex branches: git checkout -b codex/<task-name>
3. Codex implements and runs tests
4. Codex opens pull request (label: agent: codex)
5. Codex posts completion report in PR description
6. Claude reviews: design system consistency, TypeScript types, tax logic
7. Human reads both views and approves or requests changes
8. Human merges
9. Branch deleted
```

---

## C. Parallel Work Rules

Claude and Codex may work simultaneously **only if** their branches touch
completely different files.

```
main
├── claude/scenarios-header-redesign   ← only touches app/dashboard/scenarios/
└── codex/tax-engine-migration         ← only touches lib/tax/*
```

Before starting parallel work:
1. List all files each agent will touch.
2. Confirm zero overlap.
3. If overlap is discovered mid-task, the later-starting agent stops and waits.

---

## D. One Working Tree Per Agent

Two agents must **never** write to the same working directory simultaneously.

```bash
# Claude uses an isolated worktree
git worktree add ../KYN-claude-worktree claude/<task-name>

# Codex operates in a separate directory or container
```

Sharing a working directory causes unpredictable file state and corrupted diffs.

---

## E. Pull Request Requirements

Every PR must include:

- [ ] Task description and acceptance criteria
- [ ] Agent label (`agent: claude` or `agent: codex`)
- [ ] Completion report (files changed, tests run, assumptions, risks, follow-up)
- [ ] TypeScript check passing: `npx tsc --noEmit`
- [ ] Tests passing: `npx vitest run`
- [ ] Security self-check: no secrets in diff
- [ ] Human approval (at least one) before merge

---

## F. Conflict Resolution

If two branches modify the same file:

```bash
# 1. Merge the first branch to main (after review)
# 2. Rebase the second branch onto updated main
git fetch origin
git rebase origin/main

# 3. Resolve conflicts manually
# 4. Run tests after rebase
npx tsc --noEmit && npx vitest run

# 5. Force-push the rebased branch (only your own feature branch, not main)
git push --force-with-lease origin <your-branch>
```

Rules during conflict resolution:
- Do not blindly accept either side — read both versions.
- If the conflict is in tax calculation logic, escalate to human arbitration.
- Do not merge until tests pass on the rebased branch.
- Document any significant merge decisions in the PR description.

---

## G. Human Approval Before Merge

No branch merges to `main` without human approval.

- AI agents may open PRs, post reviews, and request changes.
- The final merge action is performed by a human.
- Agents must not use the GitHub API or CLI to self-merge.

---

## H. Security Audit Before Push

Before every `git push`, the pushing agent must:

```bash
# 1. Scan diff for secrets
git diff origin/main...HEAD | grep -E "eyJhbGci|service_role|sk-|\.env|password\s*="

# 2. Confirm no .env files staged
git status | grep -E "\.env"

# 3. Confirm build is clean
npx tsc --noEmit

# 4. Confirm tests pass
npx vitest run
```

If any step reveals a problem, stop. Do not push. Fix the issue first.

See [SECURITY.md](SECURITY.md) for full security policy.
