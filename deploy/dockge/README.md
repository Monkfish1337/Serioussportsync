# Standalone Dockge stack

This stack runs SeriousSportSync and SeriousSportSync Scraper from their GHCR
images without building either repository on the homelab. It deliberately
joins the existing `stremio-stack_stremio-net` network so Cloudflare, Gluetun,
Prowlarr, and Zilean remain reachable, but the stack does not own or restart
any of those services.

## Image update flow

- Merges to SeriousSportSync `main` publish
  `ghcr.io/monkfish1337/serioussportsync:latest` after CI.
- Merges to SeriousSportSync Scraper `main` publish
  `ghcr.io/monkfish1337/serioussportsync-scraper:latest` after CI.
- Dockge **Update** pulls both `latest` images and recreates only this stack.

The SSS image is public. The scraper image is private, so authenticate the
homelab Docker daemon once with a GitHub token that has `read:packages` and
access to the private scraper repository:

```bash
export CR_PAT='paste-token-here'
printf '%s' "$CR_PAT" | docker login ghcr.io -u Monkfish1337 --password-stdin
unset CR_PAT
docker pull ghcr.io/monkfish1337/serioussportsync-scraper:latest
```

Do not put the GitHub token in the stack `.env`.

## Safe migration

1. In the old Stremio stack, inspect the exact existing data mounts before
   changing anything:

   ```bash
   docker inspect serioussportsync serioussportsync-scraper \
     --format '{{.Name}}{{range .Mounts}} {{.Source}} -> {{.Destination}}{{end}}'
   docker network inspect stremio-stack_stremio-net >/dev/null
   ```

2. Back up both displayed `/app/data` source directories. The supplied
   `.env.example` defaults to the bind paths from the original stack, avoiding
   a simultaneous data migration.

3. In Dockge, create a stack named `serioussportsync` under its configured
   stacks directory. Paste `compose.yaml`, copy `.env.example` to `.env`, and
   transfer the existing secret values. Restrict it with `chmod 600 .env`.

4. Update the old Stremio stack after removing the two SSS service blocks.
   Confirm the old `serioussportsync` and `serioussportsync-scraper` containers
   are gone before starting this stack; the preserved container names prevent
   accidental parallel writers against the same data.

5. Start or **Update** the new stack. Verify:

   ```bash
   docker compose ps
   docker compose logs --tail=50 serioussportsync serioussportsync-scraper
   curl --fail http://127.0.0.1:7000/health
   curl --fail http://127.0.0.1:8180/health
   docker exec serioussportsync-scraper node -e \
     "const fetch=require('node-fetch'); const h=require('./lib/http-agent'); const u='https://api.ipify.org'; fetch(u,h.fetchOpts({},u)).then(r=>r.text()).then(console.log)"
   ```

   Compare the final public IP with Gluetun's public IP to confirm scraper
   internet traffic still exits through its HTTP proxy.

## Environment migration

| Old stack variable | Current deployment |
| --- | --- |
| `SSS_SESSION_SECRET` | Rename to `SESSION_SECRET`; preserve its value |
| `SCRAPER_AUTH_TOKEN` | Preserve; Compose also supplies it to SSS as `COMPANION_AUTH_TOKEN` |
| `PROWLARR_HYDRATE_MAX` | Remove; no longer part of stable SSS configuration |
| `STREAM_CACHE_REFRESH` | Remove; no longer part of stable SSS configuration |
| `NEWSNAB_URL`, `NEWSNAB_API_KEY`, `NEWSNAB_CATEGORIES` | Remove from stable `main`; configure per-user UU or use the separately tagged experimental native-Newznab build |
| `SOURCE_TIMEOUT_MS=45000` | Use the current `10000` default; it must remain below `SCRAPE_BUDGET_MS=25000` |

`PROWLARR_URL` and `ZILEAN_URL` remain supported as bootstrap/direct discovery
settings. If the existing scraper data already configures those sources, they
can later be removed from SSS to avoid duplicate discovery requests.
