import { normalizeSearchHistoryQuery } from './public-search-policy/public-search-policy';
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
 * Home's magnifier, Explore's search bar and its compact button open search
 * through one opener (review of #795): a second tap while a push is on its way,
 * or while the screen is up, pushes nothing, so a quick double tap never
 * stacks two search screens. `app/search.tsx` says when the screen is up.
 */
export function createSearchScreenOpener({ push, now }: { push: (href: typeof SEARCH_SCREEN_HREF) => void; now: () => number }) {
  let pushedAt = Number.NEGATIVE_INFINITY;
  let mounted = 0;
  return {
    open(): boolean {
      if (mounted > 0 || now() - pushedAt < SEARCH_SCREEN_OPEN_GUARD_MS) return false;
      pushedAt = now();
      push(SEARCH_SCREEN_HREF);
      return true;
    },
    screenMounted() {
      mounted += 1;
    },
    screenUnmounted() {
      mounted = Math.max(0, mounted - 1);
      pushedAt = Number.NEGATIVE_INFINITY;
    },
    /** Forgets every push and screen: for tests that open search again and again. */
    reset() {
      mounted = 0;
      pushedAt = Number.NEGATIVE_INFINITY;
    },
  };
}

/**
 * The field takes the focus once the push has slid in (`transitionEnd`); if
 * the navigator never says so (no animation, reduced motion), after this.
 */
export const SEARCH_SCREEN_FOCUS_FALLBACK_MS = 700;
