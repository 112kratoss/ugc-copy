/**
 * The invite a shared link carries, in one copy the app and the web share by
 * relative import (owner, 2026-11-10: "we have to add this").
 *
 * Invite & Earn was reached through its own link, `/r/<code>`, and almost
 * nobody sent one: in four months five people opened an invite link, while 46
 * arrived through a post somebody shared, and none of those could be credited
 * to the person who shared it. So a link a signed-in account shares to a post
 * or a profile now carries that account's invite code as `?r=<code>`, beside
 * the `?s=<surface>` it already carried. The page it opens records the invite
 * for a visitor who has no account yet, exactly as the invite landing does
 * (`POST /api/referrals/visit`), and shows the post: there is no page in
 * between. Signing up within the program's window then counts as that
 * account's referral.
 *
 * What lives here is the part both clients must agree on to the character: the
 * parameter's name, what a code looks like, how a link gains one and how a
 * landing reads it. The server's rule for a code is `normalizeReferralCode` in
 * `src/lib/referral.ts`; `src/__tests__/invite-share-link.test.ts` holds this
 * copy to it.
 *
 * Metro, Next.js and Vitest all compile this file, so it stays free of React
 * Native, Expo and Node imports (see this folder's tsconfig.json). It uses no
 * `URL` either: a path with no origin must work, and so must Hermes.
 */

/** The query parameter a shared link carries its sharer's invite code in. */
export const INVITE_SHARE_QUERY_PARAM = 'r';

const INVITE_SHARE_CODE_PATTERN = /^[a-z0-9]{8,24}$/;

/** An invite code as the server issues it, lower-cased, or null. */
export function normalizeInviteShareCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return INVITE_SHARE_CODE_PATTERN.test(normalized) ? normalized : null;
}

function splitLink(link: string): { base: string; query: string; hash: string } {
  const hashIndex = link.indexOf('#');
  const hash = hashIndex >= 0 ? link.slice(hashIndex) : '';
  const withoutHash = hashIndex >= 0 ? link.slice(0, hashIndex) : link;
  const queryIndex = withoutHash.indexOf('?');
  return {
    base: queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash,
    query: queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : '',
    hash,
  };
}

function withoutInviteParameter(query: string): string[] {
  return query
    .split('&')
    .filter((pair) => pair !== '' && pair.split('=')[0] !== INVITE_SHARE_QUERY_PARAM);
}

/**
 * `link` with the sharer's invite on it. A link or a path, with or without a
 * query or a fragment; anything else about it is left as it was. With no usable
 * code the link goes out without one, and an invite it already carried is taken
 * off: a link is only ever its own sharer's.
 */
export function withInviteShareCode(link: string, code: string | null | undefined): string {
  const normalized = normalizeInviteShareCode(code);
  const { base, query, hash } = splitLink(link);
  const pairs = withoutInviteParameter(query);
  if (normalized) pairs.push(`${INVITE_SHARE_QUERY_PARAM}=${normalized}`);
  return `${base}${pairs.length > 0 ? `?${pairs.join('&')}` : ''}${hash}`;
}

/** `link` as it reads inside the product: with no invite on it. */
export function withoutInviteShareCode(link: string): string {
  return withInviteShareCode(link, null);
}

/**
 * The invite a landing was opened with, read from its query (`?s=feed&r=…`, or
 * the same without the `?`). Null when there is none or it is not a code.
 */
export function readInviteShareCode(search: string | null | undefined): string | null {
  if (!search) return null;
  const query = search.startsWith('?') ? search.slice(1) : search;
  for (const pair of query.split('&')) {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex < 0) continue;
    if (pair.slice(0, separatorIndex) !== INVITE_SHARE_QUERY_PARAM) continue;
    let value = pair.slice(separatorIndex + 1);
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
    return normalizeInviteShareCode(value);
  }
  return null;
}
