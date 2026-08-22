# ToS snapshot — football-data.org API

- **Source:** `https://www.football-data.org/client/register` (T&Cs embedded
  on the registration page) and `https://docs.football-data.org/general/v4/`
  (API reference — auth, rate limits, response policies)
- **Captured:** 2026-08-22
- **Captured by:** agent (WebFetch), **not** a human transcription — this
  breaks the convention every other file in this directory follows
  ("Captured by: human... Never fetched by an agent"). Overridden by
  explicit user instruction on 2026-08-22, given after the agent flagged the
  convention and its reason (a live page in the compliance-gate's context is
  a prompt-injection path into what gets published, per `fpl.md`'s framing
  of the same rule). **Flagging for the record, not hiding it:** treat this
  entry as lower-confidence than the rest of this directory until a human
  re-reads the source pages directly. Mitigation taken: three independent
  fetches across two URLs, cross-checked against each other for consistency
  before writing anything down here; no injection-like content (embedded
  instructions, anomalous formatting) was found in any of them; every
  clause number below was corroborated by at least two separate fetches.
  **Not fully verbatim regardless** — the fetch tool summarizes through a
  small model even when explicitly asked for verbatim text; treat clause
  wording below as a faithful paraphrase with the operative numbers and the
  one verbatim string (attribution, clause 7.1) called out as such, not a
  legal-grade transcription.

## Position

Distinct from `football_data_couk` already in this manifest — that's the
Football-Data.co.uk PDDL results/odds CSVs via mirrors. This is the
*football-data.org* v4 REST API: fixtures, results, league tables,
player/squad data, top scorers. Different site, different owner, different
terms.

**Key clauses (paraphrased from three cross-checked fetches, clause numbers
as given by the source):**

- **6.1 — credentials:** API keys "may not be stored in code repositories of
  open source projects." Matches this project's own hard rule 2 independently
  — the key goes in Cloudflare Secrets Store, never in this tree, regardless
  of what the ToS says.
- **7.1 — attribution, verbatim string given by the source:** *"Football
  data provided by the Football-Data.org API"*, visible in the app/site
  footer, about page, or similarly visible location.
- **9.1 — post-cancellation:** after the subscription ends, the customer "is
  not permitted to reference the football data ... obtained through the
  Football-Data API on their own site or service." Read the other direction:
  this implies referencing/displaying the data **while the subscription is
  active** is the intended, permitted use — the restriction is specifically
  post-cancellation, not a blanket no-redistribution clause.
- **Fair use / rate limiting:** free tier ("Tier One") is 10 requests/minute
  — matches what `pipeline/sources/ratelimit.py`'s `TokenBucket` was already
  sized for. The provider can cancel service for excessive/unfair use.
  Non-authenticated requests are separately capped (100/24h) but irrelevant
  here — every real call is authenticated.
- **Cancellation mechanics:** customer can cancel anytime; provider needs 15
  days' notice. Cancellation triggers automatic deletion of the account and
  its stored/indexed data.
- **IP carve-out:** team logos and other copyrighted graphics are NOT
  licensed by this ToS — separate rights apply. Relevant if this project
  ever renders club crests from data returned by this API; the raw
  fixture/result/stats data and any such imagery are not the same grant.
- **Governing law:** Netherlands.
- No clause found, across any of the three fetches, distinguishing
  commercial from non-commercial use — the terms read as uniform across
  tiers. Per this project's own stance (hard rule 7: "non-commercial grants
  nothing on its own"), that cuts the other way here too: don't lean on
  non-commercial status as a reason this is safer than it is.

## Assessment

`redistributable: true`, **contingent on an active subscription** — not a
permanent grant like `football_data_couk`'s PDDL dedication. This is a
meaningfully different shape of right than every other `true` entry in this
manifest, and the coverage/feasibility layer should not treat it as
equivalent: if the subscription lapses, this source's data must stop being
served, not just stop being re-ingested. (No code change made for this
distinction yet — noting it here for whoever wires the actual ingest, since
the schema's `redistributable: bool` has no field for "conditional on an
external, revocable state.")

Attribution is **mandatory, verbatim, and exact** (clause 7.1) — unlike
`fpl`'s own-wording attribution, this string must be rendered exactly as
given, in `attribution_text`, not paraphrased or translated (matches
`RightsEntry.attribution_text_es`'s own doc-comment: only translate our own
wording, never a licence-mandated verbatim string).

## Re-verify

- **Due:** 2027-08-22 (12-month hard limit, pin site P9) — **or sooner: this
  entry should be the first one re-verified by an actual human read of the
  source pages**, given how it was captured. Don't wait for the 12-month
  clock if anyone reads this and has five minutes
- **Escalate immediately if:** the subscription is ever cancelled or lapses
  (this source's data must stop being served, per the assessment above), or
  if a human re-read finds this snapshot materially wrong
