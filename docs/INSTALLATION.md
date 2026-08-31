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
2. Open **Metadata** and refresh or inspect the event sources.
3. Open **Promotions** to enable, create, or test sports catalogs.
4. Open **Nuvio Collections** if you want grouped Nuvio folders and artwork.
5. Open **Account** to enable playback services and choose catalog ordering.
6. Copy or install the private manifest URL from **Account** into Nuvio or Stremio.
7. Use **Database** to inspect Smart Availability and choose which services
   should prepare selected recent events automatically.

Metadata catalogs work without TorBox, Prowlarr, Easynews, Usenet Ultimate,
NZB DAV, or NNTP. Add one playback path at a time and test it before enabling
another; this makes configuration failures much easier to identify.

## Reverse proxy or tunnel

Keep the default loopback bind when the reverse proxy runs on the same host.
Set `PUBLIC_URL=https://sports.example.com` if generated install links use the
wrong address. Set `TRUST_PROXY=1` only when direct access is blocked and all
traffic reaches SSS through your trusted proxy or tunnel.

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
