# Security Policy

## 1. Prohibited Secrets

The following must **never** appear in any committed file, PR description,
commit message, comment, or log output:

| Category | Examples |
|----------|----------|
| Supabase project URL | `https://<ref>.supabase.co` |
| Supabase anon key | JWT with `"role":"anon"` |
| Supabase service-role key | JWT with `"role":"service_role"` — **bypasses all RLS** |
| Any API key or token | `sk-...`, `pk-...`, bearer tokens |
| Passwords | Database passwords, admin credentials, OAuth secrets |
| Private keys / certificates | `*.pem`, `*.key`, `-----BEGIN ...-----` blocks |
| Personal identifiers | 주민등록번호, 사업자번호, account numbers |
| Real financial data | Real asset values, balances, tax amounts |

---

## 2. Environment Variables

### What is committed

Only `.env.local.example` is committed. It contains placeholder values:

```
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_ANON_KEY
```

### What is never committed

`.env`, `.env.local`, `.env.*` (except `.env.example` and `.env.local.example`)

These are covered by `.gitignore`. Never remove these rules from `.gitignore`.

### Adding a new variable

1. Add the key with a placeholder and a purpose comment to `.env.local.example`.
2. Add the real value to your local `.env.local` only.
3. Never paste a real value into any committed file.

---

## 3. Supabase Key Handling

| Key | Risk Level | Rule |
|-----|-----------|------|
| Project URL | Medium — reveals project ID | Never commit |
| Anon key | Medium — public-facing but scoped by RLS | Never hardcode; use env var only |
| Service-role key | **Critical** — bypasses all Row Level Security | Must never appear anywhere in the repo |

The service-role key is equivalent to a database root password.
It must exist only in Supabase dashboard and in `.env.local` on the developer's local machine.

---

## 4. Key Rotation Procedure

If a secret is accidentally committed or exposed:

```
Step 1 — Rotate immediately
  Go to the relevant service and invalidate the exposed credential.
  Do not wait. Rotation must happen before anything else.

Step 2 — Notify
  Inform the project owner (jskim-quant) immediately.

Step 3 — Remove from working tree
  Delete or replace the secret in source files.
  Commit the removal with message: "security: remove exposed credential"

Step 4 — Assess history
  Determine whether the secret was ever pushed to a shared remote.
  If yes, assume it is compromised — rotation in Step 1 already covers this.

Step 5 — History cleanup (requires human approval)
  Do NOT rewrite history without explicit human approval.
  If approved, use `git filter-repo` (preferred) or BFG Repo Cleaner.
  Coordinate with all collaborators before force-pushing.

Step 6 — Verify
  After cleanup, confirm the secret no longer appears:
  git log --all -p | grep -E "<pattern>"
```

---

## 5. Git History Audit

Run periodically, especially before onboarding new contributors:

```bash
# Check for .env files ever committed
git log --all --full-history -- "**/.env*" "*.env"

# Scan all commit diffs for key patterns
git log --all -p | grep -E "eyJhbGci|service_role|sk-[A-Za-z0-9]{20,}" | head -40

# Check for certificate blocks
git log --all -p | grep "BEGIN " | head -20
```

---

## 6. Pre-Commit Review

Before every `git commit`, run:

```bash
git diff --cached | grep -E "eyJhbGci|service_role|sk-[A-Za-z0-9]|password\s*[=:]\s*\S|\.env"
```

If any match: abort the commit, remove the secret, then re-stage.

Recommended local tool: [gitleaks](https://github.com/gitleaks/gitleaks)

```bash
# Install once
brew install gitleaks

# Run before commit
gitleaks detect --source=. --no-git
```

---

## 7. Pre-Push Review

Before every `git push`:

```bash
# Scan all commits that will be pushed
git diff origin/main...HEAD | grep -E "eyJhbGci|service_role|sk-|\.env|password\s*="

# Confirm no .env files are tracked
git ls-files | grep -E "\.env"

# Confirm TypeScript is clean
npx tsc --noEmit

# Confirm tests pass
npx vitest run
```

---

## 8. Incident Response

| Event | Action |
|-------|--------|
| Secret committed, not yet pushed | Remove from staged files, rotate credential |
| Secret pushed to origin | Rotate immediately, assess if repo is public, consider history cleanup |
| Secret pushed to public repo | Rotate immediately, open security incident, notify Supabase if Supabase key |
| Suspicious commit by AI agent | Stop agent, audit diff, do not push |
| Unknown file in repo | Investigate before deleting |

Public repo + exposed Supabase anon key = low risk (anon key is scoped by RLS).
Public repo + exposed service-role key = **critical** — rotate within minutes.

---

## 9. Repository Visibility

The GitHub remote is `https://github.com/jskim-quant/KYN`.
Visibility was not determinable via CLI during this audit.

**Action required:** Confirm visibility at `https://github.com/jskim-quant/KYN`.
If the repository is public, treat all committed content as permanently public.
