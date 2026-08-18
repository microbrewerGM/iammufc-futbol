# ToS snapshot — FBref / Sports Reference

- **Source:** `https://fbref.com/` — Sports Reference Data Use page
- **Captured:** 2026-08-18
- **Captured by:** human, transcribed from the project research set
  (`starting_ideas/01-data-sources-and-licensing.md`)
- **Capture method:** manual. **Never fetched by an agent.**

## Position

**Explicitly prohibited.** The Sports Reference Data Use page states, verbatim:

> "you should not create websites or tools based on data you scrape from Sports
> Reference or any of our sites."

Custom data requests carry a stated **minimum of $5,000**. Rate limit is 10
requests/minute, with Cloudflare bot filtering in front.

## Assessment

`redistributable: false`. This is the single clearest prohibition in the
manifest — it is not a licence gap or an ambiguity, it is a stated instruction
not to do the exact thing this project would be doing.

FBref is Opta-sourced and covers Manchester United from 2017-18 with the
richest free metric set available anywhere: progressive passes, carries,
pressures, shot-creating actions. That is precisely what makes it the honest
`NO_RIGHTS` case in the coverage matrix — the data exists, we know where it is,
it would be easy to take, and we may not.

Usable for personal research only. Never for anything served.

## Do not

- Scrape it, including via `soccerdata`, `ScraperFC`, or `fbrefdata`
- Ingest it into any bronze layer or cache it in the repository
- Serve it, aggregate it into anything served, or derive a published metric
  from it
- Set `redistributable: true` without a signed agreement in hand

## Legal note

Scraping public pages is not a CFAA violation under *hiQ v LinkedIn* (9th Cir.,
reaffirmed 2022). That does not help here. The hiQ litigation ended with
anti-scraping terms held **enforceable as breach of contract** — a $500,000
judgment entered against hiQ in December 2022 following LinkedIn's summary
judgment win. Republication can independently infringe database right or
copyright regardless of the CFAA position.

**Not computer crime is not the same as permitted.**

## Re-verify

- **Due:** 2027-08-18
- **Would change the assessment:** a paid data agreement with Sports Reference.
  Nothing else.
