# Security model

SeriousSportSync is a self-hosted, multi-user service. Administrators are
trusted to manage server-wide metadata and discovery providers. Ordinary users
can manage only their own playback providers and catalog preferences.

## Deployment boundary

- Keep the published container port on loopback and place an authenticated TLS
  reverse proxy or tunnel in front when remote access is required.
- Set `TRUST_PROXY=1` only when clients cannot bypass that trusted proxy. This
  enables forwarded client IP, host, and protocol handling for login throttling,
  generated links, and Secure cookies.
- Use a random `SESSION_SECRET` of at least 32 characters. SSS refuses to create
  sessions, resolve signatures, or encrypted data without it. Rotation revokes
  sessions and intentionally makes previously encrypted provider secrets
  unreadable so they must be entered again.
- The supplied Compose definitions run SSS as a non-root user, with all Linux
  capabilities dropped, `no-new-privileges`, a read-only root filesystem, and a
  bounded temporary filesystem. Only `/app/data` is persistent and writable.

## Application controls

- Passwords use bcrypt. Login attempts are rate-limited and unknown users take
  the same password-verification path. Password and role changes revoke all
  existing sessions for the affected user.
- Browser mutations reject cross-site origins and cross-site Fetch Metadata.
  Session cookies are HttpOnly and SameSite=Lax; Secure is enabled on trusted
  HTTPS requests. Logout is POST-only.
- Admin/account responses are non-cacheable and protected by CSP, frame,
  MIME-sniffing, referrer, and browser-permission headers. Wildcard CORS is
  restricted to the addon API consumed by Stremio-compatible clients.
- Provider credentials, provider usernames, private install tokens, and UU
  manifest URLs are encrypted at rest. Logs and browser errors redact common
  secret-bearing query parameters and URL credentials.
- Configurable HTTP endpoints reject URL credentials, cloud metadata addresses,
  unsafe protocols, and secret query parameters where a separate credential
  field exists. Local Docker/private-network service names remain supported.
- Outbound provider calls use timeouts. Indexer, companion, Prowlarr, NZB DAV,
  NZB, WebDAV, NNTP, and archive processing paths enforce bounded responses or
  traversal/resource limits.

## Reporting

Do not post credentials, private manifest URLs, logs containing personal data,
or exploit details in a public issue. Contact the repository owner privately,
include the affected version and a minimal reproduction, and rotate any secret
that may have been exposed.
