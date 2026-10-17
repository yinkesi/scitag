import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from './supabase/functions/_shared/relay.mjs';
import { startGateway } from './connect.mjs';
import http from 'node:http';

test('relay preserves authentication, path and errors without exposing a general URL proxy', async () => {
  let calls = 0;
  const relay = createRelay({ fetcher: async (url, init) => {
    calls++;
    assert.equal(url, 'https://scitag-yinkesi1.vercel.app/api/state?x=1');
    assert.equal(init.headers.get('authorization'), 'Bearer recipient-token');
    assert.equal(init.headers.get('cookie'), null);
    assert.equal(init.redirect, 'error');
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  } });
  const result = await relay(new Request('https://example.com/functions/v1/scitag-relay/api/state?x=1', { headers: { authorization: 'Bearer recipient-token', cookie: 'secret' } }));
  assert.equal(result.status, 401);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  for (const path of ['/https://evil.example', '/data/private.json', '/api/%2Fexternal']) {
    assert.equal((await relay(new Request('https://example.com/scitag-relay' + path))).status, 404);
  }
  assert.equal(calls, 1);
});

test('relay caps request bodies before forwarding and fails closed on network errors', async () => {
  let called = false;
  const relay = createRelay({ fetcher: async () => { called = true; throw new Error('private upstream error'); } });
  const huge = await relay(new Request('https://example.com/scitag-relay/api/register', { method: 'POST', body: 'a'.repeat(256001) }));
  assert.equal(huge.status, 413);
  assert.equal(called, false);
  const unavailable = await relay(new Request('https://example.com/scitag-relay/api/health'));
  assert.equal(unavailable.status, 502);
  assert.ok(!(await unavailable.text()).includes('private upstream error'));
});

test('local gateway preserves relay prefixes, rewrites downloaded config and rejects cross-site access', async t => {
  const base = 'https://example.com/functions/v1/scitag-relay';
  let calls = 0;
  const gateway = await startGateway(base, { fetcher: async (url, options) => {
    calls++;
    assert.equal(options.redirect, 'error');
    assert.equal(url, base + '/api/config');
    return Response.json({ ready: true, production: true }, { headers: { 'content-security-policy': "default-src 'none'; sandbox" } });
  } });
  t.after(() => { gateway.server.closeAllConnections(); gateway.server.close(); });
  const response = await fetch(gateway.url + '/api/config');
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.ok(!response.headers.get('content-security-policy').includes('; sandbox'));
  const config = await response.json();
  assert.equal(config.workerServer, base);
  assert.equal(config.ready, true);
  assert.equal((await fetch(gateway.url + '/api/config', { headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await fetch(gateway.url + '/api/config', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(gateway.url + '/data/private.json')).status, 404);
  const status = await new Promise((resolve, reject) => {
    http.get(gateway.url + '/api/config', { headers: { host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(status, 403);
  assert.equal(calls, 1);
});
