#!/usr/bin/env node
// Generate a new access token to add to the ACCESS_TOKENS env var.
const crypto = require('crypto');
const tok = crypto.randomBytes(16).toString('hex');
console.log(tok);
