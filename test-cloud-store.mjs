import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCloudStore } from './cloud-store.mjs';

test('cloud transaction retries a stale snapshot without publishing a stale response', async () => {
  let revision = 0, state = { count: 0 }, writes = 0;
  const store = makeCloudStore({ url: 'https://example.supabase.co', key: 'public-key', secret: 'private-secret',
    fetcher: async (url, opts) => {
      const body = JSON.parse(opts.body);
      assert.equal(body.p_secret, 'private-secret');
      if (url.endsWith('scitag_read')) return Response.json({ revision, state });
      if (writes++ === 0) { revision++; state = { count: 10 }; return Response.json(false); }
      if (body.p_revision !== revision) return Response.json(false);
      state = body.p_state; revision++;
      return Response.json(true);
    } });
  const result = await store.transact(snapshot => ({ dirty: true, state: { count: snapshot.count + 1 }, response: snapshot.count + 1 }));
  assert.equal(result, 11);
  assert.equal(state.count, 11);
});

test('database outage never falls back to local disk or returns success', async () => {
  const store = makeCloudStore({ url: 'https://example.supabase.co', key: 'key', secret: 'secret',
    fetcher: async () => new Response('unavailable', { status: 503 }) });
  await assert.rejects(store.transact(() => ({ state: {}, response: 'ok' })), /503/);
});
