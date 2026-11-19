import { agentTokenClientId } from '@/lib/agent-token';
import { readBrowserSession } from '@/lib/browser-session';

import {
  SEARCH_OPENED_PATH,
  searchOpenBody,
  type SearchOpen,
} from '../../../ugc-mobile/lib/public-search-policy/search-open-log';

/**
 * Tells the search log which result a person pressed (`POST /api/search/opened`), from the web.
 *
 * Fire and forget: it returns at once, is never awaited by the press or the navigation that
 * follows it, never throws and says nothing when it fails. The request is sent with `keepalive`,
 * so it outlives a full page load, and with the Authorization header the search itself was sent
 * with (the session's token, or none): the server keys both on the same viewer, which is what
 * ties an open to its search. That header is why this is `fetch` and not `sendBeacon`, which
 * cannot carry one. An agent's token is never sent: the route refuses one, as every route but
 * the MCP server's does. A visitor's session is none, read without loading the Supabase client
 * (`readBrowserSession`), as the search itself reads it.
 */
export function reportSearchOpen(open: SearchOpen): void {
  try {
    const body = searchOpenBody(open);
    if (!body) return;
    void readBrowserSession()
      .then((session) => {
        const token = session?.access_token ?? null;
        if (token && isAgentAccessToken(token)) return undefined;
        return fetch(SEARCH_OPENED_PATH, {
          method: 'POST',
          keepalive: true,
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
        });
      })
      .catch(() => undefined);
  } catch {
    // Nothing a person pressed may fail because the log could not be told.
  }
}

/** Whether a JWT carries the claim that makes it an agent's (agent-token.ts); false when it cannot be read. */
export function isAgentAccessToken(token: string): boolean {
  try {
    const payload = token.split('.')[1];
    if (!payload) return false;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims: unknown = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
    return claims !== null && typeof claims === 'object'
      && agentTokenClientId(claims as Record<string, unknown>) !== null;
  } catch {
    return false;
  }
}

/**
 * A pressed result's place among the results of its kind in the list it was pressed in: its
 * 1-based index among the links marked `data-search-result="<kind>"` under `container`, which are
 * in the order the search ranked them. On Top that is the section's own list; related posts
 * follow the search's own posts. Null when the press was not on a marked result.
 */
export function pressedSearchResult(
  container: Element,
  target: EventTarget | null,
): { kind: 'creator' | 'post' | 'recipe'; id: string | null; position: number } | null {
  const link = target instanceof Element ? target.closest('a[href][data-search-result]') : null;
  if (!link || !container.contains(link)) return null;
  const kind = link.getAttribute('data-search-result');
  if (kind !== 'creator' && kind !== 'post' && kind !== 'recipe') return null;
  const position = Array.from(container.querySelectorAll(`a[href][data-search-result="${kind}"]`)).indexOf(link) + 1;
  return { kind, id: link.getAttribute('data-search-result-id'), position };
}
