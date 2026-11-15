import type { MagicbookletApiClient } from './api-client';
import { searchOpenBody, type SearchOpen } from './public-search-policy/search-open-log';

/**
 * Tells the search log which result a person pressed (`POST /api/search/opened`), from the app.
 *
 * Fire and forget: it returns at once, is never awaited by the press or the navigation that
 * follows it, never throws and says nothing when it fails (offline, a refusal, a server from
 * before the route). It goes through the API client, so it carries the session's token exactly
 * as the search did, which is what lets the server tie an open to its search. The app's session
 * is never an agent's token: an agent signs in through the OAuth server, not the app.
 */
export function reportSearchOpen(
  api: Pick<MagicbookletApiClient, 'recordSearchOpen'>,
  open: SearchOpen,
): void {
  try {
    const body = searchOpenBody(open);
    if (!body) return;
    void api.recordSearchOpen(body).catch(() => undefined);
  } catch {
    // Nothing a person pressed may fail because the log could not be told.
  }
}
