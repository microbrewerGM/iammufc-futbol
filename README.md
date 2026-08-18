# iammufc-futbol

Public monorepo for iammufc.futbol. **Scaffold only — no implementation yet.**

Product definition: `../../projects/iammufc-futbol/`
Research: `../../starting_ideas/`
Roadmap: `../../docs/roadmap.md`

## Layout

```
worker/      Cloudflare Worker + static assets
  src/routes/    web, query, chat, jobs, mcp, admin
  src/security/  headers, CSP nonce, Turnstile verification  [CODEOWNERS]
  src/seo/       noindex policy, sitemap substance gate
  src/budget/    KV counters, circuit breaker
  src/i18n/      EN/ES, controlled position vocabulary
pipeline/    Python: sources, transform, metrics, render, contracts
catalog/     rights manifest, coverage matrix, metrics, Pydantic schemas
infra/       wrangler.jsonc, D1 migrations                   [CODEOWNERS]
tests/       pytest + vitest; baselines/ holds golden images
docs/        repo-local docs; the research set stays in the workspace
.github/     workflows, scripts, CODEOWNERS                  [CODEOWNERS]
.claude/     CLAUDE.md, agents/, skills/, hooks/             [CODEOWNERS]
```

## Not yet created — and deliberately

`package.json`, `pyproject.toml`, and `Dockerfile` are added at M1 with
dependency versions verified through Context7 at the time. Pinning versions in a
scaffold guarantees they are stale before the first line of code is written.

## Environments

`dev` and `production` use separate Workers, R2 buckets, D1 databases, KV
namespaces, Queues, and Containers. The enforced boundary is **token scope** —
`CF_TOKEN_DEV` has no permission on any `*-prod` resource. The `*-dev`/`*-prod`
naming convention is a readability aid, not a control.

## Laptop-only changes

Enforced by CODEOWNERS, not by convention:

- Anything under `/infra/`, `/.github/`, `/.claude/`, `worker/src/security/`
- Cloudflare API token rotation
- Container image builds Workers Builds cannot handle
- D1 Time Travel restores during an incident

Approving an auth, secrets, deploy-config, or token-scope diff from a phone is
theatre, not control.
