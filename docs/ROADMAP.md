# SeriousSportSync roadmap

## Next major feature: guided promotion builder

Replace the fragmented expert tooling with one workflow under Promotions:

1. Choose a metadata source and promotion, league, or TV show.
2. Preview imported events and the generated catalog before saving.
3. Paste several known-good release titles and, optionally, known-bad titles.
4. Derive suggested search aliases, stable recognition terms, title templates,
   session/location variants, and exclusion rules after removing volatile
   quality, codec, group, date, and episode tokens.
5. Show every generated search query and classify each example live so the
   user can correct suggestions before applying them.
6. Save the promotion and matching rules together, then run an immediate
   discovery preview without requiring a refresh or container restart.

Progress: the first slice is implemented. Promotions can derive editable,
persistent search aliases and recognition terms from known-good release titles.
Known-bad examples, live classification, query preview, and guided source/event
selection remain next.

## Configurable metadata sources

Replace hardcoded promotion-to-source assignments with reusable source
definitions and let Promotions assign a new or existing source. Preserve the
current assignments as seeded defaults, including ONE Championship's official
`watch.onefc.com` feed. See `docs/METADATA_SOURCES.md` for the audited inventory,
adapter contract, migration order, and safety requirements.

The basic path must require no JSON or regular expressions. Advanced controls
can remain available in a collapsed section.

## Cleanup task: retire superseded admin tools

Remove these standalone navigation entries, routes, views, and dead modules
once the guided promotion builder covers their required behavior:

- Power Tool
- Search
- Match Editor
- Content Studio

Preserve existing promotion, event, alias, exclusion, and editorial data during
migration. The removal is complete only when promotion creation, example-title
alias derivation, matching preview, discovery preview, and safe editing are all
available from the unified Promotions workflow.
