/**
 * Every read of a template run signs its media again, so each step and the
 * result arrive with a new address for the same file. The run page keys its
 * media on the address: taken as it comes, every poll would reload each
 * finished step, and restart a video someone is watching. A read keeps the
 * address it already had for the same file while that address has more than
 * five minutes to live.
 */

export const SIGNED_MEDIA_URL_REFRESH_WINDOW_MS = 5 * 60 * 1000;

type StableStepMedia = {
  id: string;
  outputUrl: string | null;
  renditionUrl?: string | null;
  previewUrl?: string | null;
};

type StableResultMedia = {
  url: string;
  renditionUrl?: string | null;
  previewUrl?: string | null;
};

type StableRunMedia = {
  id: string;
  steps: StableStepMedia[];
  result: StableResultMedia | null;
};

/** The stored file an address points at: the address without its query. */
function storedObject(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/** When a signed Storage address stops working, from its token's `exp`; null when it cannot be read. */
export function readSignedMediaUrlExpiryMs(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.includes('/storage/v1/object/sign/')) return null;
    const payload = parsed.searchParams.get('token')?.split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(globalThis.atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))) as { exp?: unknown };
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Whether a signed address has five minutes or less to live. An address whose expiry cannot be read is not called expiring. */
export function isSignedMediaUrlExpiring(url: string | null | undefined, nowMs = Date.now()): boolean {
  if (!url) return false;
  const expiresAtMs = readSignedMediaUrlExpiryMs(url);
  return expiresAtMs !== null && expiresAtMs - nowMs <= SIGNED_MEDIA_URL_REFRESH_WINDOW_MS;
}

/** The previous address while it points at the same file and has more than five minutes to live; otherwise the incoming one. */
export function preserveStableSignedUrl(
  previousUrl: string | null | undefined,
  incomingUrl: string | null | undefined,
  nowMs = Date.now(),
): string | null {
  if (!incomingUrl) return incomingUrl ?? null;
  if (!previousUrl || previousUrl === incomingUrl) return incomingUrl;
  if (storedObject(previousUrl) !== storedObject(incomingUrl)) return incomingUrl;
  const expiresAtMs = readSignedMediaUrlExpiryMs(previousUrl);
  return expiresAtMs !== null && expiresAtMs - nowMs > SIGNED_MEDIA_URL_REFRESH_WINDOW_MS ? previousUrl : incomingUrl;
}

function stableOptionalUrl<Media extends { renditionUrl?: string | null; previewUrl?: string | null }>(
  previous: Media | null | undefined,
  next: Media,
  key: 'renditionUrl' | 'previewUrl',
  nowMs: number,
): Partial<Pick<Media, 'renditionUrl' | 'previewUrl'>> {
  // A field the read left out stays left out.
  return next[key] === undefined ? {} : { [key]: preserveStableSignedUrl(previous?.[key], next[key], nowMs) };
}

/**
 * `nextRun` with the media addresses of `previousRun` kept where they point at
 * the same files and have more than five minutes to live: each step's
 * `outputUrl`, `renditionUrl` and `previewUrl` (matched by step id), and the
 * result's `url`, `renditionUrl` and `previewUrl`. Apply it to every read of a
 * run that replaces one already shown.
 */
export function preserveStableTemplateRunMedia<Run extends StableRunMedia>(
  previousRun: Run | null | undefined,
  nextRun: Run,
  nowMs = Date.now(),
): Run {
  if (!previousRun || previousRun.id !== nextRun.id) return nextRun;
  const previousSteps = new Map(previousRun.steps.map((step) => [step.id, step]));
  const steps = nextRun.steps.map((step) => {
    const previous = previousSteps.get(step.id);
    if (!previous) return step;
    return {
      ...step,
      outputUrl: preserveStableSignedUrl(previous.outputUrl, step.outputUrl, nowMs),
      ...stableOptionalUrl(previous, step, 'renditionUrl', nowMs),
      ...stableOptionalUrl(previous, step, 'previewUrl', nowMs),
    };
  });
  const previousResult = previousRun.result;
  const nextResult = nextRun.result;
  const result = nextResult && previousResult
    ? {
      ...nextResult,
      url: preserveStableSignedUrl(previousResult.url, nextResult.url, nowMs) ?? nextResult.url,
      ...stableOptionalUrl(previousResult, nextResult, 'renditionUrl', nowMs),
      ...stableOptionalUrl(previousResult, nextResult, 'previewUrl', nowMs),
    }
    : nextResult;
  return { ...nextRun, steps, result };
}
