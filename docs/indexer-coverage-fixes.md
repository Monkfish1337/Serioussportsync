# Indexer coverage fixes

Browser-observed examples are covered by fixture-level regression tests:

- UCL readable League Phase titles and compact-date LP/MD1 team-code titles retain both-team and date checks (previous main fix).
- MLB nickname pairs with `@` and day-first dates match without accepting different opponents or dates.
- NFL dated preseason titles match. Week-only titles now require a season/year and reject preseason/regular-season collisions and old season spans. Underscores no longer prevent week parsing.
- NBA conference Finals titles match; Summer League remains excluded from the main NBA promotion.
- Sample files are excluded from shared promotion matching.

Setting Fast response wait to zero now waits for all pipelines within their existing request/discovery budgets for every league. MLB/NFL/NBA no longer silently replace zero with eight seconds or return only the confirmed torrent shortcut.

Preseason release week numbering is not inferred from ESPN's regular-season numbering. ESPN phase metadata is retained, but preseason automatic discovery continues to use dates until the release-week mapping is verified. The configured seven-day Prowlarr queue remains unchanged, and the absence of NBA games in that period is not treated as a provider failure.

The current version label can be shared by multiple images. Pull the newly published image and recreate the running container to activate these changes.
