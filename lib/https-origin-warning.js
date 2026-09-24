'use strict';

// Warn when this page is open over HTTPS but the manifest SSS generated is
// plain HTTP (issue #31).
//
// Behind an HTTPS reverse proxy that talks to SSS over HTTP, SSS only learns
// the public scheme from PUBLIC_URL, or from X-Forwarded-Proto when
// TRUST_PROXY=1. With neither, every URL it generates is http:// — and editing
// the manifest link by hand is not enough, because the TorBox playback links
// inside each stream response are generated the same way. The browser is the
// one party that knows the page arrived over HTTPS, so the check runs there.
//
// Hidden by default (inline, so a page's own `display` rule for the class
// cannot override it); the script reveals it only on a real mismatch.
function httpsOriginWarning(inputId, className, attributes) {
  const id = 'https-origin-warning-' + inputId;
  return ''
    + '<div class="' + className + '" id="' + id + '"' + (attributes ? ' ' + attributes : '')
    + ' role="alert" style="display:none"><div>'
    + '<b>Your links are being generated as http://</b>'
    + '<p class="mb-0">This page is open over HTTPS, but SSS does not know its public address is HTTPS. '
    + 'Changing the link above by hand is not enough: playback links are generated the same way and will fail. '
    + 'Set <code>PUBLIC_URL</code> to your HTTPS address (for example <code>PUBLIC_URL=https://sports.example.com</code>) '
    + 'and recreate the container. See Installation &rarr; Reverse proxy or tunnel.</p>'
    + '</div></div>'
    + '<script>(function(){var input=document.getElementById(' + JSON.stringify(inputId) + ');'
    + 'var note=document.getElementById(' + JSON.stringify(id) + ');'
    + 'if(input&&note&&location.protocol==="https:"&&/^http:\\/\\//i.test(input.value||""))note.style.display=\"\";})();</script>';
}

module.exports = { httpsOriginWarning };
