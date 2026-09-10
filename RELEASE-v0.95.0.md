## Bitmagnet, eighteen new promotions, and a rebuilt interface

Thirteen versions of work since v0.81.0. The headline is that discovery got a
new primary source and the searches sent to it were rebuilt around measurement
rather than guesswork.

### Discovery

- **Direct Bitmagnet** is now a first-class discovery source. Against the same
  10.1M-row index on the same fixture, Bitmagnet returned 1,837 results in 65ms
  where the Torznab endpoint in front of it returned 100 and Prowlarr 175, in
  20 seconds. Info hashes arrive in the search response, and results are ordered
  by seeders server-side, so truncation cuts the tail rather than a random slice.
- **Enable toggles** on Bitmagnet, direct Prowlarr and the companion, so a
  source can be taken out of the pipeline for comparison without deleting its
  URL and credentials.
- **Sport-Video** discovery through the site's own search index, matching
  event-first, narrowed to selected teams, with a match diagnostics export.
- Releases that match no fixture from any feed now become events of their own
  rather than being discarded, under seven **Discovered <sport>** promotions.

### Query shapes

Bitmagnet ANDs every term of a query, so each extra word is one more thing the
release name has to spell identically. Measured against a live index and a real
discovery log of 832 queries, the searches SSS was emitting were the wrong
shape: league prefix plus date returned nothing at all across 169 attempts, and
the compact `YYYYMMDD` date that most football releases actually use was never
emitted once.

Fixed by emitting compact dates and bare three-letter code pairs, dropping the
prefix-plus-date combination, and prioritising code pairs ahead of the
60-query-per-event cap. The club alias table also turned out never to have been
wired into the Premier League promotion, which is why the code form the EPL
scene names its releases with had never been searched for. A fixture that
returned zero results before the change now returns four.

### Sports

Eighteen new promotions:

- **Football:** Premier League, EFL Championship, La Liga, Serie A, Bundesliga,
  Ligue 1, Eredivisie and Brasileirão, with club alias tables covering the
  naming forms releases actually use.
- **North American sport:** NFL, NBA, WNBA and College Football on a no-key
  ESPN adapter, and MLB on the official schedule.
- **Discovered sports:** Rugby, Football, Basketball, Baseball, American
  Football, Hockey and Other Sport.

Manchester United was removed — the Premier League promotion covers it.

### Interface

- A **new design system** across every page, replacing Tabler, which is now
  served from the addon rather than a CDN.
- **Configure** rebuilt as a five-step flow: services, your teams, catalogs,
  collections, install.
- A **select-your-team** wizard for Premier League, NFL, NBA and MLB.
- **Push to Nuvio** writes collections straight into a Nuvio profile. Sign-in
  happens in the browser; the password never reaches the SSS server.
- **Eight admin skins**, instance-wide, no remote assets.
- An **Event Editor** for correcting a source's date without changing the
  source; the override survives every refresh until removed.
- Refresh several promotions at once.

### Matching fixes

- NFL fixtures no longer match every American-football release on their date.
- Clubs no longer match inside one another's names, and filler club prefixes
  are stripped.
- A nationality in an event name is no longer read as a language tag.
- Competition-prefixed releases pull links correctly.
- Easynews rows no longer vanish when Usenet Ultimate produces the same release
  title — two pipelines offering the same file are different ways to play it,
  not duplicates.
- Ten leagues' worth of club naming forms recognised, including a club's own
  name spelled out.

### Reliability

- The unit suite passes on Windows. The failure was a real handle leak — an
  un-awaited `server.close()` and an unclosed SQLite index — that Linux
  tolerated and CI therefore never saw.
- Empty catalogs and meta misses are never cached.
- ESPN windows are chunked, TSDB retries bounded, the manifest revalidated.
- Container resources bounded; route and deployment tests added; CI now installs
  dependencies and runs an audit.

Full detail, including why each change was made, is in the
[changelog](https://github.com/Monkfish1337/Serioussportsync/blob/main/CHANGELOG.md).
