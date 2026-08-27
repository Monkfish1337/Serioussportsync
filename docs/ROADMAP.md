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

Progress: the end-user workflow is implemented. Metadata sources now live in a
dedicated sidebar page. Promotions can find real releases through the account's
native Newznab/NZBHydra or Prowlarr connection, filter and sort those results,
feed selected titles into editable alias/layout derivation, show every generated
query, and classify examples before saving. Expert fields remain collapsed.

## Configurable metadata sources

Replace hardcoded promotion-to-source assignments with reusable source
definitions and let Promotions assign a new or existing source. Preserve the
current assignments as seeded defaults, including ONE Championship's official
`watch.onefc.com` feed. See `docs/METADATA_SOURCES.md` for the audited inventory,
adapter contract, migration order, and safety requirements.

Progress: reusable definitions and assignments are implemented, with all nine
current sources seeded as defaults. The dedicated Metadata page creates sources,
tests saved or draft definitions, and previews normalized events without
mutating catalog data. Promotions can reassign both built-in and custom
promotions. An official, no-key MLB schedule adapter has been added and
smoke-tested through source creation, preview, promotion matching, refresh, and
stored event output. Event-diff preview and replacing dispatcher branches remain.

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

Progress: all four sidebar entries are removed and their legacy URLs redirect
to Promotions. Existing stored editor/content data is intentionally retained.
Internal dead-code deletion can follow after the new workflow has completed a
release-and-rollback cycle.

## Configurable Nuvio collections

Progress: implemented. Nuvio Collections now has a dedicated admin sidebar
workflow. The existing Combat Sports, Wrestling, Football, and Motorsport
folders remain the upgrade-safe defaults. Admins can create, edit, or remove
folders; assign new or existing promotions; choose bundled, promotion-derived,
or custom URL artwork; select tile shape and title visibility; and configure
collection-level backdrop, pinning, and the All tab. Promotion creation hands
the new promotion directly to this workflow, while each user's exported JSON
continues to respect their enabled catalogs and saved ordering.
