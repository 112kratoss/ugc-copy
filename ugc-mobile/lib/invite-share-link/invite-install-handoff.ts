import { INVITE_SHARE_QUERY_PARAM, normalizeInviteShareCode, readInviteShareCode } from './invite-share-link';

/**
 * How an invite travels from the web page that recorded it into an app that is
 * not installed yet (owner, 2026-11-10: "go with the industrial standard"; the
 * cross-device plan). Two carriers, and one format for each that the web
 * writes and the app reads, so the two cannot drift:
 *
 * - **Android: Google Play's install referrer.** The web's "Get the app" link
 *   is the Play listing with `referrer=<string>`; Play keeps the string through
 *   the install and hands it to the app (`expo-application`,
 *   `getInstallReferrerAsync`). An install that carried none reads
 *   `utm_source=google-play&utm_medium=organic`, which is not ours.
 * - **iPhone: the clipboard.** Apple passes nothing through an install, so the
 *   web's button copies the invite's own link, and the app's first launch
 *   offers Apple's Paste button when a link is waiting. What it is handed is
 *   read here, and only a link to this site's own pages counts.
 *
 * Nothing here matches devices or reads anything about the phone. Like the rest
 * of this folder it is compiled by Metro, Next.js and Vitest: no React Native,
 * Expo or Node imports, and no `URL`.
 */

/** An invite link (`/r/<code>`), or the invite a shared post or profile link carried. */
export type InviteHandoffKind = 'invite' | 'shared_link';

export type InviteInstallHandoff = {
  code: string;
  kind: InviteHandoffKind;
  /** The page the invite was opened on, as an app path: where the app may take the person. */
  path: string;
};

/** `utm_source` of a referrer this site wrote; Play's own is `google-play`. */
export const INVITE_INSTALL_REFERRER_SOURCE = 'magicbooklet-invite';

/** The hosts whose links the app accepts from the clipboard. */
export const INVITE_HANDOFF_LINK_HOSTS = ['magicbooklet.com', 'www.magicbooklet.com'] as const;

const INVITE_LANDING_PREFIX = '/r/';
const MAX_PATH_LENGTH = 512;
const MAX_CARRIED_LENGTH = 2048;

/**
 * The top-level folders an invite link may lead to: the server's own list for
 * a visit's destination (`SAFE_TOP_LEVEL_PATHS` in `src/lib/referral.ts`, held
 * equal by `src/__tests__/invite-install-handoff.test.ts`).
 */
export const INVITE_DESTINATION_TOP_LEVELS: readonly string[] = [
  '', 'ai-image-generator', 'ai-motion-transfer', 'ai-video-generator', 'ai-workflow-builder', 'blog',
  'contact', 'create', 'create-image', 'create-motion', 'create-video', 'create-workflow', 'creations',
  'creators', 'invite', 'login', 'marketplace', 'post', 'pricing', 'privacy', 'profile', 'showcase',
  'templates', 'terms',
];

/** The two pages a shared link opens: a post, a creator. One segment under each. */
const SHARED_LINK_PAGE_PATTERN = /^\/(?:showcase|creators)\/[^/]+$/;

/** A `.` or `..` segment, plain or percent-encoded, or a segment that hides a slash. */
function hasTraversal(pathname: string): boolean {
  for (const segment of pathname.split('/')) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) return true;
  }
  return false;
}

/**
 * `path` as a page this site would have written for an invite of `kind`, or `/`.
 *
 * The app goes where this says with nothing in between, and it reads it at its
 * first launch from the code built into the binary, which no over-the-air
 * update can tighten (review of 2026-11-10): so it takes only what the web
 * writes. A shared link's is the post or the creator page it was opened on,
 * with no query. An invite link's is a destination the server allows for a
 * visit, query and all. Neither holds a fragment, a backslash, a control
 * character, white space or a `..`.
 */
export function normalizeInviteHandoffPath(path: unknown, kind: InviteHandoffKind): string {
  if (typeof path !== 'string') return '/';
  const trimmed = path.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return '/';
  if (trimmed.length > MAX_PATH_LENGTH) return '/';
  // eslint-disable-next-line no-control-regex
  if (/[\\#\s\u0000-\u001f\u007f]/.test(trimmed)) return '/';
  const queryIndex = trimmed.indexOf('?');
  const pathname = queryIndex >= 0 ? trimmed.slice(0, queryIndex) : trimmed;
  if (hasTraversal(pathname)) return '/';
  if (kind === 'shared_link') return queryIndex < 0 && SHARED_LINK_PAGE_PATTERN.test(pathname) ? pathname : '/';
  return INVITE_DESTINATION_TOP_LEVELS.includes(pathname.split('/')[1] ?? '') ? trimmed : '/';
}

function normalizeKind(value: unknown): InviteHandoffKind {
  return value === 'invite' ? 'invite' : 'shared_link';
}

function readQuery(query: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const pair of query.split('&')) {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex <= 0) continue;
    const name = pair.slice(0, separatorIndex);
    if (pairs.has(name)) continue;
    try {
      pairs.set(name, decodeURIComponent(pair.slice(separatorIndex + 1).replace(/\+/g, ' ')));
    } catch {
      // A value that is not valid percent-encoding is no value.
    }
  }
  return pairs;
}

/**
 * The string Play carries through an install for `handoff`. It keeps the
 * `utm_` names Play's own reports read, and adds the invite under names of
 * its own.
 */
export function buildInviteInstallReferrer(handoff: InviteInstallHandoff): string | null {
  const code = normalizeInviteShareCode(handoff.code);
  if (!code) return null;
  const kind = normalizeKind(handoff.kind);
  const path = normalizeInviteHandoffPath(handoff.path, kind);
  return [
    `utm_source=${INVITE_INSTALL_REFERRER_SOURCE}`,
    'utm_medium=invite',
    `utm_content=${kind}`,
    `mb_r=${code}`,
    `mb_p=${encodeURIComponent(path)}`,
  ].join('&');
}

/**
 * The invite in an install referrer, or null: Play's organic answer, another
 * campaign's, a code that is not one, or anything this site did not write.
 */
export function readInviteInstallReferrer(referrer: unknown): InviteInstallHandoff | null {
  if (typeof referrer !== 'string' || referrer.length > MAX_CARRIED_LENGTH) return null;
  const pairs = readQuery(referrer.trim());
  if (pairs.get('utm_source') !== INVITE_INSTALL_REFERRER_SOURCE) return null;
  const code = normalizeInviteShareCode(pairs.get('mb_r'));
  if (!code) return null;
  const kind = normalizeKind(pairs.get('utm_content'));
  return { code, kind, path: normalizeInviteHandoffPath(pairs.get('mb_p'), kind) };
}

/** The Play listing's link with `handoff` on it; the listing's own link when there is nothing to carry. */
export function withInviteInstallReferrer(playStoreUrl: string, handoff: InviteInstallHandoff): string {
  const referrer = buildInviteInstallReferrer(handoff);
  if (!referrer) return playStoreUrl;
  const hashIndex = playStoreUrl.indexOf('#');
  const base = hashIndex >= 0 ? playStoreUrl.slice(0, hashIndex) : playStoreUrl;
  const pairs = base.includes('?')
    ? base.slice(base.indexOf('?') + 1).split('&').filter((pair) => pair !== '' && pair.split('=')[0] !== 'referrer')
    : [];
  pairs.push(`referrer=${encodeURIComponent(referrer)}`);
  const origin = base.includes('?') ? base.slice(0, base.indexOf('?')) : base;
  return `${origin}?${pairs.join('&')}`;
}

/**
 * The link the web copies for an iPhone, and draws as a QR code for a laptop:
 * the invite's own page on `origin`. An invite link is `/r/<code>` with where
 * it led; a shared link is the page it was opened on with `r` back on it. Both
 * are links the installed app already opens. A shared link with no page of its
 * own to name goes out as the invite's landing: no other page records an invite.
 */
export function buildInviteHandoffLink(origin: string, handoff: InviteInstallHandoff): string | null {
  const code = normalizeInviteShareCode(handoff.code);
  if (!code) return null;
  const base = origin.replace(/\/+$/, '');
  const kind = normalizeKind(handoff.kind);
  const path = normalizeInviteHandoffPath(handoff.path, kind);
  if (kind === 'invite' || path === '/') {
    return `${base}${INVITE_LANDING_PREFIX}${code}${path === '/' ? '' : `?next=${encodeURIComponent(path)}`}`;
  }
  return `${base}${path}?${INVITE_SHARE_QUERY_PARAM}=${code}`;
}

/**
 * The invite in a link the app was handed (Apple's Paste button), or null.
 * Only an https link to one of `hosts` counts, so text that merely mentions a
 * code, or another site's link, is never taken for an invite.
 */
export function readInviteHandoffLink(
  text: unknown,
  hosts: readonly string[] = INVITE_HANDOFF_LINK_HOSTS,
): InviteInstallHandoff | null {
  if (typeof text !== 'string') return null;
  const link = text.trim();
  if (link.length > MAX_CARRIED_LENGTH || /\s/.test(link)) return null;
  const match = /^https:\/\/([^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?(?:#.*)?$/i.exec(link);
  if (!match) return null;
  if (!hosts.includes(match[1]!.toLowerCase())) return null;
  const path = match[2] ?? '/';
  const query = match[3] ?? '';

  if (path.startsWith(INVITE_LANDING_PREFIX)) {
    let rawCode = path.slice(INVITE_LANDING_PREFIX.length).replace(/\/+$/, '');
    try {
      rawCode = decodeURIComponent(rawCode);
    } catch {
      return null;
    }
    const code = normalizeInviteShareCode(rawCode);
    if (!code) return null;
    return { code, kind: 'invite', path: normalizeInviteHandoffPath(readQuery(query).get('next'), 'invite') };
  }

  const code = readInviteShareCode(query);
  if (!code) return null;
  // The page's path as the link spells it, encoding and all. A link with an
  // invite on any page but a post's or a creator's is not one this site shares:
  // its invite is kept, and it leads nowhere.
  return { code, kind: 'shared_link', path: normalizeInviteHandoffPath(path, 'shared_link') };
}
