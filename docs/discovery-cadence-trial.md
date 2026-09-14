# Discovery cadence trial

Trial starting 14 September 2026. Keep the existing seven-day selection and Prowlarr daily budgets.

| Source | Schedule | Bound |
| --- | --- | --- |
| Prowlarr | One search every 120 seconds | Existing 400 requests per indexer per UTC day, including metadata |
| Bitmagnet | Hourly rotating batches | 50 eligible events per run; existing search caches and per-account TorBox observations reused |
| Sport-Video | Hourly index checks | 25 detail preparations, sequential with ten seconds between records |

Saved settings override shipped defaults. The hourly schedules were applied to the running instance; code protections require the updated container.

Readiness is estimated from start time: MLB/NFL four hours, NBA three and a half, UCL/EPL three, other promotions six. Unknown times wait until six hours after the dated UTC day ends. These are estimates, not verified final scores. Cancelled/postponed and removed promotions are excluded from Bitmagnet work.

Prowlarr gives unsearched events priority, then tries recent missing events more frequently. Within 24 hours of readiness, variants retry hourly and complete cycles after six hours; through day three, two/twelve hours; older events, six/twenty-four hours. Identical queries retain the six-hour suppression. Proven indexers are preferred; every tenth selection explores alternatives. Existing daily limits, disabled-indexer checks and exponential failure cooldowns remain. HTTP 429/503 Retry-After extends persisted cooldowns and stops further metadata requests in that pass.

Sport-Video detail 404/410 failures wait 24 hours. Other detail failures back off from one to 24 hours. Source 429/503 responses pause network access for at least an hour or the supplied Retry-After, whichever is longer; that pause survives restarts. Preparation waits until an event is eligible. Manual per-release preparation bypasses the record retry schedule, but not source-wide cooldowns.

Compare daily for three to seven days: eligible/matched/missing events by promotion; requests and successful searches per indexer; consecutive failures and cooldowns; first-search backlog; Bitmagnet run errors, duration and search reuse; Sport-Video prepared releases and failures. The initial baseline was 111 Prowlarr-eligible events, 96 with saved matches, 720pier 275 requests/74 cumulative successes and RuTracker 155/17. Successes are cumulative, so compare daily differences. Bitmagnet's last run reported 183 errors with promotion-not-found as the latest error. These baseline figures do not guarantee playback.

Do not raise budgets while an indexer is failing. If source failures rise, reduce frequency/preparation caps and investigate before clearing cooldowns. The hourly batch is a revisit opportunity, not a guarantee that every event is searched each hour; caches, batch rotation, account checks and worker duration still apply.
