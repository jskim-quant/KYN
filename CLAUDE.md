# CLAUDE.md — Claude Code Instructions

All shared rules are in [AGENTS.md](AGENTS.md). This file adds Claude Code-specific guidance.

---

## Project Overview

**KYN** is a Korean family estate-tax planning web application.

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 14 App Router |
| Language | TypeScript (strict) |
| UI | React 18 + custom CSS design system |
| Backend | Supabase (PostgreSQL + Auth + RLS) |
| Styling | Tailwind CSS + `app/globals.css` (KYN design system) |
| Testing | Vitest |

Key directories:

```
app/                   Next.js pages and layouts (App Router, all 'use client')
app/globals.css        KYN design system (2,000+ lines — scope carefully)
lib/tax/               New pure-function tax engine — use for all new tax work
lib/tax.ts             Legacy monolithic engine (4,083 lines) — do not add new imports
supabase/              Schema and migrations
docs/                  Workflow, security, and privacy documentation
__tests__/             Vitest test suite
```

---

## Design System

KYN uses a **flat squared design** — no `border-radius`, no `box-shadow`.

CSS variables (defined at top of `app/globals.css`):

```
--gold  --ink  --bg  --line  --line-strong
--ink-faint  --ink-soft  --gold-deep  --gold-tint
--red  --red-tint  --green  --green-ink  --green-tint
--amber  --amber-tint  --paper  --paper-sink  --serif  --sans
```

Scope your CSS under the correct class:
- `.kyn-strategy` — strategy page
- `.main` — scenarios page
- `.kyn-dashboard-content` — dashboard

**Never add** Tailwind utility classes for visuals (background, border, shadow, radius)
inside scoped design-system sections. Use CSS variables via the scoped classes.

---

## Do Not Touch

- `app/dashboard/members/page.tsx` — locked, do not modify

---

## Tax Engine Rule

Two engines coexist during migration:

- `lib/tax.ts` — legacy (4,083 lines). Do not add new imports of this file.
- `lib/tax/*` — new pure-function engine. Use this for all new or modified tax logic.

If a task requires tax calculations, read `lib/tax/types.ts` first to understand
the type contracts.

---

## Tax and Legal Accuracy

- Never invent tax rules, rates, or thresholds.
- Never assert legal conclusions.
- If tax logic is uncertain, mark it clearly with a code comment:
  ```ts
  // VERIFY: uncertain whether this threshold applies under 상증세법 §XX
  ```
- Source of truth for Korean tax law is the current 상속세및증여세법 (상증세법).

---

## Branch Workflow

```bash
# Start every task on a dedicated branch
git checkout main
git pull origin main
git checkout -b claude/<task-name>

# Or use a worktree for isolation
claude worktree create claude/<task-name>
```

Never commit to `main` directly.

---

## Commit Discipline

- Prefer small, focused commits over large all-at-once commits.
- Each commit should be buildable and testable.
- Run `npx tsc --noEmit` before committing TypeScript changes.
- Run `npx vitest run` before declaring a task complete.

---

## What Not To Do

| Prohibited | Reason |
|-----------|--------|
| Broad refactors without request | Causes scope creep and merge conflicts |
| Updating docs without code changes | Creates misleading documentation |
| Adding comments that describe what code does | Well-named identifiers do that |
| Adding `border-radius` or `box-shadow` anywhere | Violates KYN design system |
| Importing from `lib/tax.ts` in new code | Migration in progress to `lib/tax/*` |
| Modifying files outside task scope | Violates AGENTS.md §4 |

---

## Security Review Before Commit

Before every `git commit`:

```bash
git diff --cached | grep -E "eyJhbGci|service_role|sk-|\.env|password\s*="
```

If any match appears, do not commit. Remove the secret first.

---

## Request Review Before Merge

Open a pull request and request human review. Do not self-merge into `main`.
