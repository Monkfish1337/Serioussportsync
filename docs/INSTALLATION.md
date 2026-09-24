# Installation and recovery guide

This guide starts with an empty server. It installs SeriousSportSync by itself;
playback services are optional and can be connected after the catalog works.

## Before you start

You need:

- a server with Docker Engine and Docker Compose v2;
- a terminal on that server;
- port 7000 available, or another port selected in `.env`;
- the server's LAN IP if SSS will be opened from another device.

SSS stores its accounts, encryption-dependent settings, promotions, metadata,
collections, and availability database in a Docker volume. Preserve both that
volume and `SESSION_SECRET` when updating or rebuilding.

## 1. Download the deployment files

Linux, macOS, or a Linux server shell:

```bash
mkdir serioussportsync
cd serioussportsync
curl -LO https://raw.githubusercontent.com/Monkfish1337/Serioussportsync/main/docker-compose.yml
curl -LO https://raw.githubusercontent.com/Monkfish1337/Serioussportsync/main/.env.example
cp .env.example .env
```

PowerShell:

```powershell
New-Item -ItemType Directory serioussportsync
Set-Location serioussportsync
Invoke-WebRequest https://raw.githubusercontent.com/Monkfish1337/Serioussportsync/main/docker-compose.yml -OutFile docker-compose.yml
Invoke-WebRequest https://raw.githubusercontent.com/Monkfish1337/Serioussportsync/main/.env.example -OutFile .env.example
Copy-Item .env.example .env
```

## 2. Create the secret

Generate a value on Linux/macOS:

```bash
openssl rand -hex 32
```

Or in PowerShell:

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
```

Open `.env`, paste the generated value after `SESSION_SECRET=`, and leave
`ADMIN_USER=admin` unless you want a different administrator username.

For another device on the same LAN, also uncomment `SSS_BIND_ADDRESS` and set
it to the server's LAN IP, for example:

```env
SESSION_SECRET=your-generated-value
ADMIN_USER=admin
SSS_BIND_ADDRESS=192.168.1.10
```

Leaving `SSS_BIND_ADDRESS` commented makes SSS accessible only from the server
itself at `127.0.0.1`. Using `0.0.0.0` listens on every server adapter; use the
specific LAN IP where possible. Never forward port 7000 directly from the
Internet.

## 3. Start and verify

```bash
docker compose up -d
docker compose ps
docker compose logs --tail=100 serioussportsync
```

The container should show `Up`. Open one of:

- `http://127.0.0.1:7000/` when using a browser on the server;
- `http://SERVER-LAN-IP:7000/` after setting `SSS_BIND_ADDRESS` for LAN access;
- your HTTPS address when using a reverse proxy or tunnel.

If the container restarts or exits, the final log lines normally identify a
missing/short secret, occupied port, or unwritable data mount.

## 4. First-time setup

1. Create the account whose username matches `ADMIN_USER`.
2. Open **Metadata** and refresh or inspect the event sources. The shipped UEFA
   Champions League catalog uses UEFA's official public fixture feed and needs
   no provider account or API key.
3. Open **Metadata** to choose a ready-made event provider or create one from a
   public JSON/API schedule. Test it and check the sample events before saving.
4. Open **Promotions** and use **Create promotion**. Select the saved provider,
   choose a sample event, and use **Alias Research** to find and classify real
   release titles through the playback services already configured on the account.
5. Open **Nuvio Collections** if you want grouped Nuvio folders and artwork.
6. Open **Account** to enable playback services and choose catalog ordering.
7. Copy or install the private manifest URL from **Account** into Nuvio or Stremio.
8. Use **Database** to inspect Smart Availability and choose which services
   should prepare selected recent events automatically.

Metadata catalogs work without TorBox, Prowlarr, Easynews, or built-in Usenet.
Add one playback path at a time and test it before enabling another; this
makes configuration failures much easier to identify.

## Reverse proxy or tunnel

Keep the default loopback bind when the reverse proxy runs on the same host.

**If users reach SSS over HTTPS, set `PUBLIC_URL`.** A reverse proxy such as
Nginx Proxy Manager, Caddy or Traefik usually terminates HTTPS and talks to SSS
over plain HTTP on port 7000. SSS builds every link it hands out from the
address it sees, so without `PUBLIC_URL` those links start with `http://`:

```yaml
environment:
  PUBLIC_URL: "https://sports.example.com"
```

Recreate the container after setting it (`docker compose up -d`).

This covers more than the install link. SSS also generates the TorBox playback
links inside every stream response, and they use the same address. Changing
the manifest link from `http://` to `https://` by hand makes the addon install
and its catalogs work, but playback then fails, because those playback links
are still `http://`. The Account page and the setup wizard show a warning when
the page is open over HTTPS but the generated links are HTTP.

Alternatively, `TRUST_PROXY=1` makes SSS read the scheme and host from the
proxy's `X-Forwarded-Proto` and `X-Forwarded-Host` headers. Set it only when
direct access is blocked and all traffic reaches SSS through your trusted proxy
or tunnel, because those headers are otherwise client-controlled.
`PUBLIC_URL` is the simpler choice when there is a single public address.

Cloudflare Tunnel setups often work without either setting, because
Cloudflare's "Always Use HTTPS" redirects `http://` requests to `https://`
before they reach SSS. Setting `PUBLIC_URL` is still recommended there.

The [Security guide](SECURITY.md) explains forwarded-header trust and exposure.

## Updating

```bash
docker compose pull
docker compose up -d --remove-orphans
docker compose logs --tail=50 serioussportsync
```

Do not regenerate `SESSION_SECRET` during an update. The Docker volume is not
removed by these commands.

## Backup and rebuild

Back up:

1. the deployment directory containing `docker-compose.yml` and `.env`;
2. the Docker volume mounted at `/app/data`.

Find the exact volume name and mount point without guessing:

The admin **Backup** link also downloads the data directory while SSS runs.
SSS copies ordinary files into a private staging directory on the data volume, creates standalone
online snapshots of every SQLite database (including Prowlarr queue state), checks
database integrity, and verifies the completed archive before downloading it.
Failed preparation returns an error rather than a partial archive. A disconnected
request cancels preparation. Temporary files are removed after download.
This needs free space on the data volume for both the snapshots and compressed
archive, rather than the container's limited `/tmp`. The `.backup-staging`
directory is excluded from backups. If a container is forcibly terminated during
a backup, remove abandoned `sss-backup-*` directories there once no backup is running.
Databases are individually consistent; this is not one transaction across all
stores. Files configured outside the data directory and the deployment `.env`
must be backed up separately. Preserve the same `SESSION_SECRET`.

```bash
docker inspect serioussportsync --format '{{range .Mounts}}{{println .Name .Source "->" .Destination}}{{end}}'
```

Stop SSS before copying the displayed volume data so SQLite and JSON files are
consistent:

```bash
docker compose stop
```

Use your normal server backup tool to copy the displayed source, then restart:

```bash
docker compose start
```

To rebuild, restore `.env` with the same `SESSION_SECRET`, restore the data to a
volume mounted at `/app/data`, and run `docker compose up -d`. A restored data
volume with a different secret may leave encrypted provider settings unusable.

For a recovery rehearsal, use a separate Compose project and fresh volume, with
a different container name and host port. Extract the backup into that volume
and ensure its files belong to the image's `app` user before starting it. Verify
admin login, user roles, access requests, provider settings, metadata and saved
discovery releases there. For rollback, restore the pre-upgrade backup into a
fresh isolated volume and start the earlier image; do not point it at databases
already migrated by a newer image.

Developers can run `npm run test:recovery` for the disposable fixture drill.
It does not use production accounts or data. The publish workflow also runs it
inside the release candidate before uploading the image. See
[v1 release validation](V1_READINESS.md) for the remaining operator checks.

## Common problems

### The page does not open from another computer

The secure default is `127.0.0.1`. Set `SSS_BIND_ADDRESS` in `.env` to the
server's LAN IP and recreate the container with `docker compose up -d`.

### Port 7000 is already in use

Set `SSS_HOST_PORT=7010` in `.env`, recreate the container, and open port 7010.

### Configuration saves report “Invalid request origin”

Open SSS using the same public scheme and hostname configured in `PUBLIC_URL`.
For a reverse proxy, forward the original host and protocol. Enable
`TRUST_PROXY=1` only when the proxy is the exclusive route to SSS.

### Behind an HTTPS proxy, the addon installs but playback fails

Symptoms: the generated manifest URL starts with `http://`, catalogs and stream
rows appear, but choosing a TorBox row fails (for example
`avformat can't open input | Invalid data found when processing input`), and
the SSS logs show no `resolve` request when Play is selected.

SSS does not know its public address is HTTPS, so the playback links it
generates are `http://`. Set `PUBLIC_URL=https://your.domain`, recreate the
container, then reinstall the addon from **Account** so every link uses the
HTTPS address. See [Reverse proxy or tunnel](#reverse-proxy-or-tunnel).

### Metadata works but playback does not

This normally means SSS itself is installed correctly. Test the enabled path
from **Account**, inspect **Logs**, and confirm container-to-container URLs use
Docker service names rather than `localhost`.

## Dockge and companion deployments

The root Compose file is the recommended fresh install. The
[standalone Dockge stack](../deploy/dockge/README.md) is an advanced two-service
migration template for operators who already run the private companion,
Gluetun, Prowlarr, Zilean, and a shared Docker network. It is not required for
a new SSS installation.
