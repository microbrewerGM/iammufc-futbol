# iammufc.futbol — project memory

Non-commercial Manchester United stats site. 100% Cloudflare. Solo dev.
Budget ~$5/mo. Public repo, public site.

## Grounding (MANDATORY)

Before writing code against ANY external API or library, call Context7:
resolve-library-id -> query-docs. Never rely on training data for Cloudflare,
Wrangler, Hono, Agents SDK, mplsoccer, kloppy, socceraction, pandas, Pydantic.
Several Cloudflare products here are open beta — verify limits before relying
on them.

## Hard rules

1. Never commit data. No *.parquet, *.csv, *.db, *.sqlite, no data/**.
   Non-redistributable data is never committed and never served.
2. Never write a secret into a file. Keys live in Cloudflare Secrets Store and
   GitHub Environment secrets. football-data.org ToS forbids keys in OSS repos.
3. Never republish red-tier sources: FBref/Sports Reference, Understat,
   WhoScored, Sofascore, FotMob, Transfermarkt, Capology, Spotrac.
4. **Retired 2026-08-22: there is no `production` environment.** This project
   is dev-only by decision — see the Guardrails section below and
   `docs/exceptions.md` E-014. Historical note, not a live rule: while prod
   existed, dev and prod resources were kept separate and dev code never
   pointed at `*-prod`.
5. Pin all GitHub Actions to full 40-character commit SHAs. Never a tag.
6. Salary figures from third parties are estimates; label them as such.
7. Dependency versions follow N-1 minor with exact pins, no ranges (ADR-0003).
   Pin by the strongest identifier available (ADR-0004). New pin site ->
   add a row to docs/pin-registry.md. Deviation -> add an entry to
   docs/exceptions.md. Neither is optional.

## Guardrails

- **Decided 2026-08-21: no manual-approval gate for dev.** PRs, merges to
  `main`, and dev deploys — including changes under `/infra`, `/.github`,
  `/.claude`, or `worker/src/security` — do not need to be flagged for a
  laptop review or wait for approval. CI green -> self-approve -> merge,
  same as any other change. Full detail: `docs/runbooks/self-review-protocol.md`.
- **Retired 2026-08-22: there is no `production` environment or promotion
  gate left.** This project is dev-only by explicit decision (`docs/exceptions.md`
  E-014) — the GitHub `production` Environment, `deploy-prod` job,
  `CF_TOKEN_PROD`, and the `iammufc-prod` D1/KV pair are all being removed.
  Tier 3 in self-review-protocol.md is retired along with it; only Tier 1/2
  remain live. If a `production` environment is ever reintroduced, this
  exception and Tier 3 are the template to restore, not to reinvent.
- Never run wrangler deploy, wrangler versions upload, wrangler d1 execute
  --remote, wrangler secret, or git push --force.
- Keep PRs small and single-purpose — the primary review surface is a phone.
- Never update a golden-image baseline and the renderer in the same PR.

## Design invariants

- **The LLM never emits SQL.** Chat proposes a constrained QueryIntent; the user
  confirms; the metric layer executes deterministically. Text-to-SQL fails
  silently, which is disqualifying here.
- **Feasibility is a lookup in the coverage matrix, never an inference.** Never
  claim data exists. Five states: available, computable_now_queued,
  computable_but_expensive, no_data, no_rights.
- **Artifact key = sha256(canonical intent, data snapshot id, transform code
  version, renderer version).** Any input change invalidates.
- **Attribution renders from lineage**, never hand-coded.
- **Renders must be deterministic** — pinned versions, fixed fonts, Agg backend,
  fixed seed. Non-determinism silently breaks content-addressed caching.
- **Event coordinates exist for 2017-18 only.** Show the gap; never fabricate.
- Event data goes to R2 Parquet, never D1.
- Every chart ships a data-table fallback and generated alt text.

## Look and feel

Before building or changing UI, read `docs/design-principles.md` (workspace
root, two levels up). It is guidance, not law — depart from it deliberately
rather than by accident. The short version:

- Let the interface signify how it works; a paragraph of explanation is a
  signifier we failed to build.
- Hierarchy is contrast. The answer outranks its provenance — the chart is the
  content, the parsed intent and artifact key are not.
- White space beats grids. Four-point scale.
- One sans-serif. Tighten large headings (letter-spacing about -2%,
  line-height 110-120%). This is closer to a dashboard than a landing page, so
  lean small.
- Colour needs a job. Our primary red is BRAND, so do not also use it for
  danger, and never signal by hue alone.
- Every action deserves a response: hover, active, focus-visible, disabled.
  All reachable in pure CSS, so `script-src 'none'` stays intact.
