# ToS snapshot — Football-Data.co.uk (via mirrors)

- **Source:** `https://www.football-data.co.uk/` — ingested via the
  datahub.io / openfootball mirrors, **not** by scraping the origin site
- **Captured:** 2026-08-18
- **Captured by:** human, transcribed from the project research set
  (`starting_ideas/01-data-sources-and-licensing.md`)
- **Capture method:** manual. **Never fetched by an agent.**

## Position

The mirrors publish under **Open Data Commons Public Domain Dedication and
Licence (PDDL) v1.0**, which dedicates the data to the public domain. No
attribution is legally required.

- Free CSVs: match results plus betting odds
- English Premier League back to 1993-94
- No API — flat CSV downloads
- **No xG, no player box scores.** Match-level only

## Assessment

`redistributable: true`. The cleanest rights position of any source in the
manifest, alongside openfootball.

Ingest from the **mirrors**, whose licence terms are explicit, rather than from
the origin site. This is a deliberate choice: the mirror carries a stated
licence, and the origin does not.

Attribution is not legally required under PDDL. Credit is still given in the
site footer as good practice — it costs nothing and the source deserves it.

## Legal context

Under *Football Dataco v Yahoo!* (CJEU C-604/10) fixture lists do not attract
copyright absent creative selection, and under *Fixtures Marketing* they lack
the sui-generis database right because the investment is in *creating* the data
rather than *obtaining* it. Raw match facts are largely free to state. The
liability that does exist attaches to wholesale copying of a substantial part of
someone's structured database — which is why aggregating facts we compile
ourselves across several sources is a materially safer posture than mirroring
one provider.

## Re-verify

- **Due:** 2027-08-18
- **Escalate if:** the mirrors change or drop the PDDL dedication
