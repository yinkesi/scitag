/** Small-group compatibility store: compare-and-swap prevents lost updates across instances. */
export function makeCloudStore({ url = process.env.SUPABASE_URL, key = process.env.SUPABASE_PUBLISHABLE_KEY,
  secret = process.env.SCITAG_DATABASE_SECRET, fetcher = fetch } = {}) {
  if (!url || !key || !secret) throw new Error('Supabase 云端存储配置尚未完成');
  async function rpc(name, input) {
    const response = await fetcher(url.replace(/\/$/, '') + '/rest/v1/rpc/' + name, {
      method: 'POST', headers: { apikey: key, 'content-type': 'application/json' },
      body: JSON.stringify({ p_secret: secret, ...input }), signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`云端数据库请求失败 (${response.status})`);
    return response.json();
  }
  async function transact(handle) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const snapshot = await rpc('scitag_read', {});
      if (!Number.isSafeInteger(snapshot?.revision) || !Object.hasOwn(snapshot, 'state')) throw new Error('云端数据库响应格式无效');
      const result = await handle(snapshot.state);
      if (!result.dirty) return result.response;
      const committed = await rpc('scitag_commit', { p_revision: snapshot.revision, p_state: result.state });
      if (committed === true) return result.response;
      if (committed !== false) throw new Error('云端数据库写入响应格式无效');
    }
    throw new Error('云端数据库繁忙，请重试');
  }
  return { transact };
}
