# ToS snapshot — Fantasy Premier League public API

- **Source:** `https://fantasy.premierleague.com/api/`
- **Captured:** 2026-08-18
- **Captured by:** human, transcribed from the project research set
  (`starting_ideas/01-data-sources-and-licensing.md`)
- **Capture method:** manual. **Never fetched by an agent.** The rights persona
  reasons only over this file — putting a live page into the compliance gate's
  context is a prompt-injection path into the decision about what may be
  published.

## Position

There is **no published API terms document**. This endpoint is undocumented and
unofficial. The Premier League has neither granted nor refused a licence for it.

What is true:

- The endpoints are public, unauthenticated, and stable enough that a large
  ecosystem of community tools depends on them
- Use is widespread and long-standing, and has not been objected to
- Endpoints have changed without notice before and can again

## Assessment

**Tolerated use, not a granted licence.** Recorded as `redistributable: true`
on the basis of established practice rather than an express permission. This is
the weakest rights position of any source currently in the manifest, and it is
the one most likely to change.

Relevant endpoints:

| Endpoint | Provides |
|---|---|
| `bootstrap-static/` | Players, teams, positions, season metadata |
| `fixtures/` | Fixture list and results |
| `element-summary/{id}/` | Per-player match-by-match history |
| `event/{gw}/live/` | Gameweek live data |

Current season only. History from 2016-17 via the
`vaastav/Fantasy-Premier-League` community archive.

## Re-verify

- **Due:** 2027-08-18 (12-month hard limit, pin site P9)
- **Escalate immediately if:** the Premier League publishes API terms, objects to
  community use, or the endpoints move behind authentication
- **Display constraint:** fantasy points are a scoring construct, not a football
  performance measure. Label them as such wherever shown.
