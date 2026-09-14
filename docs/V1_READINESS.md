# v1 release validation

Ship v1 after these checks are completed against the release candidate. Unit checks
alone do not establish sustained indexer coverage or real client playback.

## Automated checks

- Run the complete unit, account and Nuvio suites.
- Verify damaged account stores return a recovery error without replacing data.
- Verify simultaneous initial setup requests create only one administrator.
- Verify pending, declined and expired applicants cannot sign in; regular users
  cannot approve requests or enable DIY Usenet.
- Start the actual release image through the hardened Compose configuration before
  pushing it to the registry. Main and version tags use the same check; the tested
  local image is retagged and pushed without rebuilding.

## Seven-day operational trial

Keep the seven-day event window and measured queue settings stable. Record daily:

| Measure | Evidence |
| --- | --- |
| Backlog | Eligible, searched, untouched and outstanding events in Prowlarr discovery |
| Coverage | Saved matched events per MLB, NFL and NBA; UCL searches in Database |
| Playback | Discovered, matched and ready counts; actual Nuvio playback samples |
| Indexer health | Requests, successes, failure streaks, cooldowns and Prowlarr restrictions |
| Speed | Request durations in Logs for first requests and repeat requests |
| Recovery | Queue state and budgets retained after a normal container restart |

Choose representative recent events from UCL, MLB, NFL and NBA, including compact
dates, scene separators, team abbreviations, season/week titles and overnight fixtures.
Confirm rejected samples, highlights and different fixtures do not become full-match links.
An empty league outside its season is not a coverage failure: use a historical fixture
for matching validation without expanding the production queue unnecessarily.

Investigate new SSS-caused indexer disablements, repeated identical queries, stalled
backlogs, lost state or incorrect links before release. Coverage depends on upstream
content and account access; record those limitations rather than treating every zero
result as an application failure.

## Restore and rollback drill

Use an isolated deployment, never the production data volume, for this drill.

1. Save the current image tag or digest, `.env`, and a consistent data backup.
   Preserve the same `SESSION_SECRET`: encrypted credentials depend on it.
2. Restore into a separate data volume using the documented installation procedure.
3. Verify admin login, user roles, pending requests, provider credentials, events,
   matching rules, queue budgets and a representative saved release.
4. Upgrade that deployment to the candidate and verify the same data again.
5. Restore the pre-upgrade backup with the earlier image and verify recovery.
   Do not assume an earlier binary can safely read newly migrated databases.

The operational trial and full container restore drill are manual release gates.
Document their outcomes before creating the v1 tag.
