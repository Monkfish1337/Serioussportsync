# v1 release validation

Ship v1 after these checks are completed against the release candidate. Unit checks
alone do not establish sustained indexer coverage or real client playback.

## Automated checks

- Run the complete unit, account and Nuvio suites.
- Verify damaged account stores return a recovery error without replacing data.
- Verify simultaneous initial setup requests create only one administrator.
- Verify pending, declined and expired applicants cannot sign in; regular users
  cannot approve requests or enable DIY Usenet.
- Verify an online backup restores committed WAL data from both databases as
  standalone files, includes account files, rejects damaged databases, and
  cancels failed/disconnected preparation. The admin download route is covered
  by the account suite; regular users cannot download backups.
- Run `npm run test:recovery`. It creates disposable accounts, encrypted provider
  keys, matching rules, events and saved releases, downloads the admin backup,
  restores it to a separate directory, starts the real application, verifies login
  and data, and repeats the checks after restart. `SSS_ROLLBACK_SOURCE` optionally
  points to an extracted earlier source tree to verify rollback against a fresh
  extraction of the backup. Earlier source dependencies must be available.
- Start the actual release image through the hardened Compose configuration before
  pushing it to the registry. Main and version tags use the same check; the tested
  local image is retagged and pushed without rebuilding.
  The same recovery drill also runs inside that hardened candidate container.

## Focused operational trial

Keep the seven-day event window and measured queue settings stable. Use existing
logs plus a focused trial covering discovery, retries and playback; a fixed seven
days of waiting is not required. Record the following before release:

| Measure | Evidence |
| --- | --- |
| Backlog | Eligible, searched, untouched and outstanding events in Prowlarr discovery |
| Coverage | Seven-day usable release counts and missing reasons per promotion in Discovery Overview |
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

## Validation recorded on 14 September 2026

- Complete unit suite: 611 passed. Account and Nuvio suites passed. Production
  dependency audit reported zero vulnerabilities.
- Application recovery and rollback to source commit `3d17790f`: passed using
  disposable fixture data. Accounts, roles, pending requests, encrypted keys,
  events, matching rules, usable saved releases and queue budgets survived.
- Live discovery snapshot: 112 eligible events, 96 with saved matches, 16 still
  missing and five awaiting their first search. RuTracker and 720pier each showed
  zero consecutive failures. Saved matches still require an account playback check.
- Full release-container execution is enforced before publishing, but was not run
  on this workstation because Docker is unavailable. The fixture drill supplements
  the isolated real-volume restore and earlier-image rollback check above.
- Real Nuvio playback across representative UCL, MLB, NFL and NBA events, sustained
  queue observations, and the production-data restore drill are not marked passed
  by automated fixture checks. Record these outcomes against the candidate image.
