import { AppError } from './shared.ts';
import type { Route } from './shared.ts';

export function networkKind(url: URL): 'tor' | 'i2p' | 'regular' {
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  return host.endsWith('.onion') ? 'tor' : host.endsWith('.i2p') ? 'i2p' : 'regular';
}
export function routePolicy(endpoint: string, route: Route = 'auto', proxyUrl?: string): { route: Exclude<Route, 'auto'>; proxyUrl?: string } {
  if (!['auto', 'direct', 'tor', 'i2p', 'proxy'].includes(route)) throw new AppError('Unsupported route. No direct fallback will be attempted.');
  const target = new URL(endpoint), kind = networkKind(target);
  const selected = route === 'auto' ? kind === 'regular' ? 'direct' : kind : route;
  if (kind !== 'regular' && selected !== kind) throw new AppError(`This address requires ${kind === 'tor' ? 'Tor' : 'I2P'}. No direct fallback will be attempted.`);
  if (selected === 'i2p' && kind !== 'i2p') throw new AppError('I2P is limited to .i2p destinations; public-internet outproxy routing is not enabled.');
  if (proxyUrl) {
    let proxy: URL; try { proxy = new URL(proxyUrl); } catch { throw new AppError('Invalid network proxy URL.'); }
    // Both accepted spellings use remote destination DNS in our SOCKS5 transport.
    if (proxy.protocol === 'socks5h:') proxy = new URL(proxy.href.replace(/^socks5h:/, 'socks5:'));
    if (proxy.username || proxy.password || proxy.search || proxy.hash || proxy.pathname !== '' && proxy.pathname !== '/') throw new AppError('Network proxy URL must not contain credentials, paths, queries, or fragments.');
    if (!['http:', 'https:', 'socks5:'].includes(proxy.protocol) || networkKind(proxy) !== 'regular') throw new AppError('Use an HTTP(S) or SOCKS5 network proxy. Chained private-network proxies are not supported.');
    const local = ['127.0.0.1', '[::1]', 'localhost'].includes(proxy.hostname);
    if (selected === 'tor' && (!local || proxy.protocol !== 'socks5:')) throw new AppError('Tor requires a local SOCKS5 router.');
    if (selected === 'i2p' && (!local || proxy.protocol !== 'http:')) throw new AppError('I2P requires a local HTTP proxy.');
    if (selected === 'direct') throw new AppError('Select a proxy route before setting a network proxy URL.');
    return { route: selected, proxyUrl: proxy.href.replace(/\/$/, '') };
  }
  if (selected === 'proxy') throw new AppError('Enter a network proxy URL.');
  return { route: selected, ...(selected === 'i2p' ? { proxyUrl: 'http://127.0.0.1:' + (target.protocol === 'https:' ? '4445' : '4444') } : {}) };
}
