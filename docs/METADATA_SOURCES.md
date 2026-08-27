# Metadata source inventory and configuration plan

## Active assignments

| Promotion | Current source | Hardcoded selector |
| --- | --- | --- |
| UFC | TheSportsDB | league `4443` |
| ONE Championship | Official ONE website (`watch.onefc.com`) | `onefc` adapter |
| WWE | TheSportsDB | league `4444` |
| AEW | TheSportsDB | league `4563` |
| Formula 1 | TheSportsDB | league `4370` |
| Boxing | TheSportsDB | league `4445` |
| MotoGP | TheSportsDB | league `4407` |
| Match of the Day | TMDB | TV shows `224` and `3231` |
| Man United | football-data.org | team `66` |

Custom sources can also use MLB's official public Stats API schedule. It needs
no API key and supplies game IDs, dates, teams, venues, status, and start times.

ONE's adapter discovers the current Next.js build identifier from the official
site, then reads its public upcoming and past event data. Wikipedia remains a
description/artwork enrichment source for eligible promotions. The repository
also contains Wikipedia year-page and list-page primary adapters, although no
currently enabled built-in promotion selects either as its primary source.

Custom promotions select a named source definition. TheSportsDB,
football-data.org, TMDB, the official ONE feed, and official MLB schedule are
supported in the source registry. The refresh dispatcher still owns a hardcoded
branch for every adapter.

## Target model

Metadata sources should become named, reusable configurations stored separately
from promotions. A source definition contains:

- stable source ID and user-facing name;
- adapter type and adapter-specific fields;
- capability metadata (league, team, TV series, official promotion feed, or
  Wikipedia list);
- credential reference, never a plaintext credential;
- enabled state and last validation/refresh result.

Implementation status: the registry, nine seeded definitions, dedicated
Metadata page, reusable source creation, official MLB adapter, promotion
reassignment, external validation, and normalized sample preview are
implemented. Preview is read-only and never replaces stored events. Existing
behavior is preserved when no override is saved. The common adapter dispatch
contract and refresh event-diff preview remain the next source-focused slices.

Promotions should store a `sourceRef`. The Promotions page will offer:

1. Assign an existing source.
2. Create and validate a new source, then assign it.
3. Change the source used by an existing custom or built-in promotion.
4. Preview events from that source before saving or refreshing.

The initial seeded definitions should reproduce today's behavior exactly. That
makes the migration reversible and prevents an upgrade from silently changing
catalog contents.

## Adapter contract

Move refresh dispatch behind a registry with a common contract:

- `describe()` returns fields, capabilities, and credential requirements;
- `validate(config)` checks configuration and returns sample metadata;
- `fetch(config, context)` returns source records;
- `transform(record, promotion)` selects the existing normalizer;
- `redact(config)` removes secrets from logs and admin responses.

Initial adapters: TheSportsDB, official ONE, official MLB, football-data.org, TMDB,
Wikipedia year pages, and Wikipedia list pages. The official ONE adapter can be
reused by another promotion only when its feed contains events that promotion
can safely filter; the UI must explain this rather than presenting every source
as universally compatible.

## Migration and safety

- Seed the nine current assignments as system source definitions.
- Allow system definitions and built-in promotion assignments to be overridden,
  while retaining a one-click reset to shipped defaults.
- Migrate existing custom promotion source fields to source definitions without
  deleting the old fields until a successful refresh confirms the new mapping.
- Keep API keys in the encrypted settings store and reference them symbolically.
- Validate source changes and show an event diff before replacing stored events.
- Prevent deletion of a source while promotions still reference it.
