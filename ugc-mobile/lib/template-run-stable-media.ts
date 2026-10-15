import { env } from './env';
import { signedStorageUrlExpiresAt } from './media-url-expiry';

/**
 * Every read of a template run signs its media again, so each step and the
 * result arrive with a new address for the same file. The run screen's media is
 * keyed on the address (expo-image's cache key, the player's source): taken as
 * it comes, every poll would download each finished step's original again and
 * restart a clip someone is watching. A read keeps the address it already had
 * for the same file while that address has more than five minutes to live. The
 * web applies the same rule (`src/lib/template-run-stable-media.ts`).
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

/** Whether a signed address has five minutes or less to live. An address whose expiry cannot be read is not called expiring. */
export function isSignedMediaUrlExpiring(
  url: string | null | undefined,
  nowMs = Date.now(),
  storageBaseUrl: string = env.supabaseUrl,
): boolean {
  if (!url) return false;
  const expiresAtMs = signedStorageUrlExpiresAt(url, storageBaseUrl);
  return expiresAtMs !== null && expiresAtMs - nowMs <= SIGNED_MEDIA_URL_REFRESH_WINDOW_MS;
}

/** The previous address while it points at the same file and has more than five minutes to live; otherwise the incoming one. */
export function preserveStableSignedUrl(
  previousUrl: string | null | undefined,
  incomingUrl: string | null | undefined,
  nowMs = Date.now(),
  storageBaseUrl: string = env.supabaseUrl,
): string | null {
  if (!incomingUrl) return incomingUrl ?? null;
  if (!previousUrl || previousUrl === incomingUrl) return incomingUrl;
  if (storedObject(previousUrl) !== storedObject(incomingUrl)) return incomingUrl;
  const expiresAtMs = signedStorageUrlExpiresAt(previousUrl, storageBaseUrl);
  return expiresAtMs !== null && expiresAtMs - nowMs > SIGNED_MEDIA_URL_REFRESH_WINDOW_MS ? previousUrl : incomingUrl;
}

function stableOptionalUrl<Media extends { renditionUrl?: string | null; previewUrl?: string | null }>(
  previous: Media | null | undefined,
  next: Media,
  key: 'renditionUrl' | 'previewUrl',
  nowMs: number,
  storageBaseUrl: string,
): Partial<Pick<Media, 'renditionUrl' | 'previewUrl'>> {
  // A field the read left out stays left out.
  return next[key] === undefined ? {} : { [key]: preserveStableSignedUrl(previous?.[key], next[key], nowMs, storageBaseUrl) };
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
  storageBaseUrl: string = env.supabaseUrl,
): Run {
  if (!previousRun || previousRun.id !== nextRun.id) return nextRun;
  const previousSteps = new Map(previousRun.steps.map((step) => [step.id, step]));
  const steps = nextRun.steps.map((step) => {
    const previous = previousSteps.get(step.id);
    if (!previous) return step;
    return {
      ...step,
      outputUrl: preserveStableSignedUrl(previous.outputUrl, step.outputUrl, nowMs, storageBaseUrl),
      ...stableOptionalUrl(previous, step, 'renditionUrl', nowMs, storageBaseUrl),
      ...stableOptionalUrl(previous, step, 'previewUrl', nowMs, storageBaseUrl),
    };
  });
  const previousResult = previousRun.result;
  const nextResult = nextRun.result;
  const result = nextResult && previousResult
    ? {
      ...nextResult,
      url: preserveStableSignedUrl(previousResult.url, nextResult.url, nowMs, storageBaseUrl) ?? nextResult.url,
      ...stableOptionalUrl(previousResult, nextResult, 'renditionUrl', nowMs, storageBaseUrl),
      ...stableOptionalUrl(previousResult, nextResult, 'previewUrl', nowMs, storageBaseUrl),
    }
    : nextResult;
  return { ...nextRun, steps, result };
}
