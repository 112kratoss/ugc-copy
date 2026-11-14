import { normalizeSearchHistoryQuery } from './public-search-policy/public-search-policy';
import type { SearchEntranceOrigin } from './search-entrance';
import type { PublicSearchType } from './types';

/** Where Home and Explore open search: a fresh screen, an empty field. */
export const SEARCH_SCREEN_HREF = '/search';

const SEARCH_TYPES: readonly PublicSearchType[] = ['top', 'creators', 'posts', 'recipes'];

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The search a link opens the screen on: `q` and `type`, as the web's search
 * address carries them (`/search?q=nano&type=posts`). A missing or empty `q`
 * is an empty field; an unknown `type` is Top.
 */
export function searchScreenParams(params: { q?: string | string[]; type?: string | string[] }): {
  query: string | null;
  type: PublicSearchType | null;
} {
  const query = normalizeSearchHistoryQuery(first(params.q) ?? '');
  const type = first(params.type);
  return {
    query: query || null,
    type: query && SEARCH_TYPES.includes(type as PublicSearchType) ? (type as PublicSearchType) : null,
  };
}

/**
 * How long after a push another open is ignored when the screen has not
 * mounted yet: longer than the native push takes to take the touch.
 */
export const SEARCH_SCREEN_OPEN_GUARD_MS = 600;

/**
 * How long after a push the screen it mounts may grow out of the pressed
 * control: a screen mounts within a frame or two of its push.
 */
export const SEARCH_SCREEN_ORIGIN_TTL_MS = 1000;

/**
 * Home's magnifier, Explore's search bar and its compact button open search
 * through one opener (review of #795): a second tap while a push is on its way,
 * or while the screen is up, pushes nothing, so a quick double tap never
 * stacks two search screens. `app/search.tsx` says when the screen is up.
 */
export function createSearchScreenOpener({ push, now }: { push: (href: typeof SEARCH_SCREEN_HREF) => void; now: () => number }) {
  let pushedAt = Number.NEGATIVE_INFINITY;
  let mounted = 0;
  // The control the push was made from, for the screen's field to grow out of
  // (lib/search-entrance.ts). Handed to the screen once, as it mounts.
  let origin: SearchEntranceOrigin | null = null;
  return {
    open(from: SearchEntranceOrigin | null = null): boolean {
      if (mounted > 0 || now() - pushedAt < SEARCH_SCREEN_OPEN_GUARD_MS) return false;
      pushedAt = now();
      origin = from;
      push(SEARCH_SCREEN_HREF);
      return true;
    },
    /**
     * The control this opening was pressed from, for a screen mounting within
     * SEARCH_SCREEN_ORIGIN_TTL_MS of the push. Not cleared by the read, so a
     * render React repeats (Strict Mode) reads the same; a screen mounting
     * later (a link's, or one whose push never mounted) grows out of nothing
     * (review of #812, 3).
     */
    takeOrigin(): SearchEntranceOrigin | null {
      return now() - pushedAt <= SEARCH_SCREEN_ORIGIN_TTL_MS ? origin : null;
    },
    screenMounted() {
      mounted += 1;
    },
    screenUnmounted() {
      mounted = Math.max(0, mounted - 1);
      pushedAt = Number.NEGATIVE_INFINITY;
      origin = null;
    },
    /** Forgets every push and screen: for tests that open search again and again. */
    reset() {
      mounted = 0;
      pushedAt = Number.NEGATIVE_INFINITY;
      origin = null;
    },
  };
}

