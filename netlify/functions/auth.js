'use strict';
// POST /api/auth  { passcode }  ->  { token, expiresAt }
// This is the only function that does not require a token; it verifies the
// passcode itself (constant-time) and fails closed if ACCESS_PASSCODE is unset.
const { json, passcodeMatches, issueToken } = require('./lib/common');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  if (!process.env.ACCESS_PASSCODE) {
    return json(503, { error: 'not_configured', message: 'ACCESS_PASSCODE is not set on the server, so the app is locked.' });
  }
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'bad_request', message: 'Invalid request.' });
  }
  if (!passcodeMatches(body.passcode)) {
    await sleep(700); // gentle brake on guessing
    return json(401, { error: 'unauthorized', message: 'That passcode did not match.' });
  }
  return json(200, issueToken());
};
