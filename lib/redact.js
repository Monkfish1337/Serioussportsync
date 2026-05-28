// Mask secret-bearing query params before strings hit the logs.
//
// Prowlarr download-proxy URLs and some indexer error messages embed
// credentials as query params (?apikey=..., &passkey=..., &token=...).
// Those URLs/errors get logged during stream resolution, so scrub them to
// avoid leaking the Prowlarr API key (or indexer passkeys) into container
// logs that may be shipped elsewhere.

const SECRET_PARAM = /([?&](?:api[_-]?key|api[_-]?token|access[_-]?token|token|passkey|apikey|secret|pass)=)([^&\s'"]+)/gi;

function redact(input) {
  if (input == null) return input;
  return String(input).replace(SECRET_PARAM, (m, p1) => p1 + '***');
}

module.exports = { redact };
