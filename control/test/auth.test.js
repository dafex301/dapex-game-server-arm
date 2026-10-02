import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from '../src/auth.js';

function invoke(headers, config) {
  return new Promise((resolve) => {
    const request = { get: (name) => headers[name.toLowerCase()] };
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { resolve({ status: this.statusCode, body, actor: request.actor }); } };
    createAuth(config)(request, response, () => resolve({ status: 200, actor: request.actor }));
  });
}

test('allows configured Cloudflare Access identities', async () => {
  const result = await invoke({ 'cf-access-authenticated-user-email': 'Admin@Example.com' }, { authDisabled: false, internalToken: null, allowedEmails: new Set(['admin@example.com']) });
  assert.deepEqual(result, { status: 200, actor: 'admin@example.com' });
});

test('rejects unlisted identities and accepts internal bearer token', async () => {
  const config = { authDisabled: false, internalToken: 'secret', allowedEmails: new Set(['admin@example.com']) };
  assert.equal((await invoke({ 'cf-access-authenticated-user-email': 'other@example.com' }, config)).status, 401);
  assert.equal((await invoke({ authorization: 'Bearer secret' }, config)).actor, 'internal-service');
});
