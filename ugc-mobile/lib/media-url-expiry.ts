/** Metadata only: the server still authorizes the replacement URL. */
export function getPrivateMediaExpiry(url: string, storageBaseUrl: string): {
  expiresAt: number;
  bucket: string;
  path: string;
} | null {
  try {
    const source = new URL(url);
    const storage = new URL(storageBaseUrl);
    if (source.origin !== storage.origin || source.username || source.password || url.includes('\\')) return null;
    const match = /^\/storage\/v1\/object\/sign\/(generated_images|generated_videos|generated_audio|generation_inputs)\/(.+)$/.exec(source.pathname);
    if (!match) return null;
    const payload = source.searchParams.get('token')?.split('.')[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const parsed = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))) as { exp?: unknown };
    if (typeof parsed.exp !== 'number' || !Number.isFinite(parsed.exp) || parsed.exp <= 0) return null;
    const path = decodeURIComponent(match[2]);
    if (!path || path.includes('\\') || path.split('/').some(part => part === '..' || part === '.')) return null;
    return { expiresAt: parsed.exp * 1000, bucket: match[1], path };
  } catch {
    return null;
  }
}

export function resolveMediaUrlForExpiry(url: string, storageBaseUrl: string, apiBaseUrl: string, now: number): string {
  const expiry = getPrivateMediaExpiry(url, storageBaseUrl);
  if (!expiry || expiry.expiresAt > now + 30_000) return url;
  const proxy = new URL('/api/media', apiBaseUrl);
  proxy.search = new URLSearchParams({ bucket: expiry.bucket, path: expiry.path }).toString();
  return proxy.href;
}
