import { connect } from 'node:net';
import { Agent, ProxyAgent, Socks5ProxyAgent, fetch as networkFetch } from 'undici';
import type { Dispatcher } from 'undici';
import { AppError } from './shared.ts';
import type { Connection } from './shared.ts';
import { routePolicy } from './route-policy.ts';

// Probe only the local SOCKS greeting: no target names, keys, or paid request are sent.
export async function socksAvailable(port: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port }); let bytes = Buffer.alloc(0), done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; socket.destroy(); signal?.removeEventListener('abort', abort); resolve(ok); };
    const abort = () => finish(false);
    socket.setTimeout(800, () => finish(false)); socket.once('error', () => finish(false)); socket.once('end', () => finish(false));
    socket.once('connect', () => socket.write(Buffer.from([5, 1, 0])));
    socket.on('data', chunk => { bytes = Buffer.concat([bytes, chunk]); if (bytes.length >= 2) finish(bytes[0] === 5 && bytes[1] === 0); });
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  });
}
export async function detectTor(signal?: AbortSignal, probe = socksAvailable): Promise<string> {
  for (const port of [9050, 9150]) { signal?.throwIfAborted(); if (await probe(port, signal)) return `socks5://127.0.0.1:${port}`; }
  signal?.throwIfAborted(); throw new AppError('Tor is not available on local ports 9050 or 9150. Start your Tor router/Tor Browser or set its local SOCKS5 URL in Connections. Nothing was sent directly.', 503);
}
export function routedFetch(c: Connection): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== new URL(c.endpoint).origin) throw new AppError('Cross-origin provider request blocked.', 403);
    const plan = routePolicy(c.endpoint, c.route, c.proxyUrl), signal = init?.signal ?? undefined;
    if (signal?.aborted) signal.throwIfAborted();
    let dispatcher: Dispatcher;
    if (plan.route === 'direct') dispatcher = new Agent({ connections: 1, pipelining: 1, connectTimeout: 20000 });
    else {
      const proxy = plan.proxyUrl || await detectTor(signal);
      dispatcher = proxy.startsWith('socks5:') ? new Socks5ProxyAgent(proxy, { connections: 1, pipelining: 1, connectTimeout: 60000, requestTls: { rejectUnauthorized: true } }) : new ProxyAgent({ uri: proxy, connections: 1, pipelining: 1, proxyTunnel: false, connectTimeout: 60000, requestTls: { rejectUnauthorized: true }, proxyTls: { rejectUnauthorized: true } });
    }
    const destroy = () => { void dispatcher.destroy().catch(() => {}); };
    const clean = () => { signal?.removeEventListener('abort', destroy); destroy(); };
    signal?.addEventListener('abort', destroy, { once: true });
    try {
      // A per-request dispatcher ignores HTTP_PROXY/NO_PROXY/global dispatchers. Never retry or change routes.
      const response = await networkFetch(url, { ...init, redirect: 'error', dispatcher } as Parameters<typeof networkFetch>[1]);
      if (!response.body) { clean(); return new Response(null, { status: response.status, headers: [...response.headers] }); }
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) { try { const next = await reader.read(); if (next.done) { controller.close(); clean(); } else controller.enqueue(next.value); } catch { clean(); controller.error(new AppError('Provider stream stopped or route failed; no direct fallback was attempted.', 502)); } },
        async cancel() { try { await reader.cancel(); } finally { clean(); } },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: [...response.headers] });
    } catch (e) {
      clean(); if (signal?.aborted) signal.throwIfAborted();
      if (e instanceof AppError) throw e;
      throw new AppError(plan.route === 'direct' ? 'Provider connection failed. Check the address and TLS certificate. No automatic retry was attempted.' : `The ${plan.route === 'proxy' ? 'network proxy' : plan.route.toUpperCase()} route failed. Check that the router is running and ready. No direct fallback or automatic retry was attempted.`, 502);
    }
  };
}
