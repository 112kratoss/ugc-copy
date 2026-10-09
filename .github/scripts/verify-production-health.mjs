import { pathToFileURL } from 'node:url';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Only a different, valid build ID may be retried during alias propagation. */
export async function verifyProductionHealth({
  origin, releaseSha, secret, timeoutMs = 60000, intervalMs = 5000,
  fetchImpl = fetch, now = Date.now, sleep = delay, log = console.log,
}) {
  if (!/^[a-f0-9]{40}$/.test(releaseSha || '')) throw Error('An exact release SHA is required');
  if (!secret) throw Error('Protected health credentials are missing');
  const url = new URL('/api/ops/backend-health', origin);
  if (url.username || url.password || (url.protocol !== 'https:'
    && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw Error('Invalid protected health origin');
  }
  const deadline = now() + timeoutMs;
  let attempts = 0;
  while (now() < deadline && attempts < 12) {
    attempts++;
    url.search = new URLSearchParams({ release: releaseSha, attempt: String(attempts) }).toString();
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${secret}`, 'Cache-Control': 'no-cache' },
        redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - now()))),
      });
    } catch {
      throw Error('Protected production health request failed');
    }
    if (!response.ok) throw Error(`Protected production health returned HTTP ${response.status}`);
    let body;
    try { body = await response.json(); } catch { throw Error('Protected production health returned invalid JSON'); }
    if (!body || typeof body !== 'object' || typeof body.buildId !== 'string' || !/^[a-f0-9]{40}$/.test(body.buildId)) {
      throw Error('Protected production health did not identify an exact build');
    }
    if (body.buildId === releaseSha) {
      if (body.status !== 'ok') throw Error('Production backend health is not ok for the released commit');
      if (now() >= deadline) throw Error('Protected production health verification exceeded its deadline');
      log(`Protected production health verified ${releaseSha} after ${attempts} request(s).`);
      return { buildId: releaseSha, status: 'ok', attempts };
    }
    log(`Protected health still serves ${body.buildId}; waiting for ${releaseSha}.`);
    const remaining = deadline - now();
    if (remaining <= 0 || attempts >= 12) break;
    await sleep(Math.min(intervalMs, remaining));
  }
  throw Error('Protected production health did not serve the released commit within its verification window');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyProductionHealth({
    origin: process.env.PRODUCTION_BASE_URL,
    releaseSha: process.env.RELEASE_SHA,
    secret: process.env.OPS_READ_SECRET,
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
