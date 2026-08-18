# ToS snapshot — Understat

- **Source:** `https://understat.com/`
- **Captured:** 2026-08-18
- **Captured by:** human, transcribed from the project research set
  (`starting_ideas/01-data-sources-and-licensing.md`)
- **Capture method:** manual. **Never fetched by an agent.**

## Position

**No redistribution licence of any kind.** There is no published grant
permitting republication of Understat's data.

- Free xG and shot data with x/y coordinates
- Top-5 European leagues plus the Russian Premier League from 2014-15
- **Covers Manchester United across the full period we care about**
- No API — JSON is embedded in page source

## Assessment

`redistributable: false`. Non-negotiable.

This is the most painful entry in the manifest, and that is exactly why it is
here. Understat has the data the site most wants — current-season xG with shot
coordinates for Manchester United — and we cannot publish it. Scraping public
pages is not a computer-crime violation under *hiQ v LinkedIn*, but that
litigation ended with anti-scraping terms held **enforceable as breach of
contract**, and republication can independently infringe database right or
copyright regardless.

**Consequence in the catalog:** the `xg` coverage cell citing this source
resolves to `NO_RIGHTS`, not `NO_DATA`. The distinction is meaningful to a user:
`NO_DATA` is a gap we could close by integrating a source; `NO_RIGHTS` is a gap
we may never close without paying for a licence.

## Do not

- Ingest it into any bronze layer
- Cache it in the repository
- Serve it, aggregate it into anything served, or derive a published metric
  from it
- Set `redistributable: true` without human review and a licence in hand

## Re-verify

- **Due:** 2027-08-18
- **Would change the assessment:** Understat publishing an express
  non-commercial redistribution licence. Nothing short of that.
