// Fixed upstream only: this is a second route to the same authenticated app,
// never an arbitrary URL proxy. No platform/database secret is used here.
export function createRelay({ upstream = 'https://scitag-yinkesi1.vercel.app', fetcher = fetch } = {}) {
  const origin = new URL(upstream).origin;
  const assets = new Set(['/', '/index.html', '/app.js', '/workspace.js', '/entry.js', '/style.css', '/brand.svg', '/worker-client.zip']);
  return async function relay(request) {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/^\/(?:functions\/v1\/)?scitag-relay(?=\/|$)/, '') || '/';
    const api = /^\/api\/[a-zA-Z0-9_./%-]+$/.test(pathname);
    const error = (status, message) => Response.json({ error: message }, { status });
    if ((!api && !assets.has(pathname)) || /%2e|%2f|%5c/i.test(pathname) || url.search.length > 4096) return error(404, '入口不存在');
    if (!['GET', 'POST'].includes(request.method) || (!api && request.method !== 'GET')) return error(405, '不支持的操作');
    const headers = new Headers();
    for (const name of ['authorization', 'content-type', 'accept']) if (request.headers.has(name)) headers.set(name, request.headers.get(name));
    let body;
    if (request.method === 'POST') {
      const reader = request.body?.getReader();
      const chunks = []; let size = 0;
      if (reader) while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > 256000) { await reader.cancel(); return error(413, '请求内容过长'); }
        chunks.push(item.value);
      }
      body = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
    }
    try {
      const response = await fetcher(origin + pathname + url.search, { method: request.method, headers, body,
        redirect: 'error', signal: AbortSignal.timeout(25000) });
      const responseHeaders = new Headers({ 'cache-control': api ? 'no-store' : 'public, max-age=60', 'x-content-type-options': 'nosniff' });
      for (const name of ['content-type', 'content-security-policy']) if (response.headers.has(name)) responseHeaders.set(name, response.headers.get(name));
      return new Response(response.body, { status: response.status, headers: responseHeaders });
    } catch { return error(502, '备用入口暂时无法连接主服务，请稍后重试'); }
  };
}
