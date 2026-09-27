import { MAX_UPDATE_METADATA } from './update-manifest';

export type UpdateFetch = (url: string, init: RequestInit) => Promise<Response>;
const hosts = new Set([
  'raw.githubusercontent.com',
  'github.com',
  'release-assets.githubusercontent.com',
]);
export function updateNetworkUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    !hosts.has(url.hostname)
  )
    throw new Error('App updates require HTTPS on an approved download host.');
  return url;
}
export async function fetchUpdateFeed(
  url: string,
  signal: AbortSignal,
  request: UpdateFetch = fetch,
) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  let current = updateNetworkUrl(url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    deadline.throwIfAborted();
    const response = await request(current.href, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      signal: deadline,
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const next = response.headers.get('location');
      if (!next || redirects === 5) throw new Error('The update server redirected too many times.');
      current = updateNetworkUrl(new URL(next, current).href);
      continue;
    }
    const reader = response.body?.getReader();
    try {
      if (response.status !== 200 || !reader)
        throw new Error(`The update server returned HTTP ${response.status}. Try again later.`);
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_UPDATE_METADATA * 2))
        throw new Error('The signed update information is too large.');
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        deadline.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_UPDATE_METADATA * 2)
          throw new Error('The signed update information is too large.');
        chunks.push(value);
      }
      deadline.throwIfAborted();
      return Buffer.concat(chunks);
    } finally {
      await reader?.cancel();
    }
  }
  throw new Error('The update server could not be reached.');
}
