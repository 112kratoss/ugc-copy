import {
  normalizeInviteHandoffPath,
  type InviteHandoffKind,
  type InviteInstallHandoff,
} from '../../ugc-mobile/lib/invite-share-link/invite-install-handoff';
import { normalizeInviteShareCode } from '../../ugc-mobile/lib/invite-share-link/invite-share-link';

/**
 * The web's half of carrying an invite to another device (the cross-device
 * plan, owner 2026-11-10): which device and browser the visitor is on, what the
 * page should offer them there, and the invite this tab holds to hand over.
 * The formats that travel are shared with the app
 * (`ugc-mobile/lib/invite-share-link/invite-install-handoff.ts`); this file is
 * the browser's rules, with nothing of React in it so each can be tested alone.
 */

export type { InviteHandoffKind, InviteInstallHandoff };

/**
 * Whether the app in the stores keeps an invite handed to it at install, per
 * platform. It reads the hand-off at its FIRST launch, which runs the code built
 * into the binary, never an over-the-air update: so a platform turns true only
 * once a store build with that code is live for everyone (the plan's step 4),
 * in a change of its own. While a platform is false the page tells that phone
 * to join here first, which keeps the invite, and says so of the app.
 *
 * Both true since 2026-11-14 (owner: "yes flip it"): 0.1.9 carries the hand-off
 * on both, iOS build 62 on the App Store since 2026-11-12 and Android build 81
 * in production since 2026-11-14. Setting a platform back to false is the
 * rollback: the page then sends that phone to join here first again.
 */
export const INVITE_APP_HANDOFF_LIVE: Readonly<Record<'android' | 'ios', boolean>> = {
  android: true,
  ios: true,
};

/**
 * A link opened with `handoff=preview` is shown the page as it will be once the
 * app keeps a handed-over invite, on that page only and marked as a preview:
 * for checking the store links and the copied link on real phones before the
 * store builds are out. The page takes the switch off its address and never
 * keeps it for the tab, so it does not travel on by a copied address or a reload.
 * On a platform already live it changes nothing, and the page draws no preview
 * note there (`inviteHandoffPreviewOnly`).
 */
export const INVITE_HANDOFF_PREVIEW_PARAM = 'handoff';
export const INVITE_HANDOFF_PREVIEW_VALUE = 'preview';

export type InviteHandoffDevice = 'android' | 'ios' | 'desktop';

/** The visitor's device, from what the browser says of itself. */
export function inviteHandoffDevice(userAgent: string, maxTouchPoints = 0): InviteHandoffDevice {
  if (/android/i.test(userAgent)) return 'android';
  if (/iphone|ipad|ipod/i.test(userAgent)) return 'ios';
  // An iPad asks for the desktop site by default and calls itself a Mac; only it has touch.
  if (/macintosh/i.test(userAgent) && maxTouchPoints > 1) return 'ios';
  return 'desktop';
}

const NAMED_IN_APP_BROWSER_PATTERN = new RegExp(
  [
    'FBAN', 'FBAV', 'FB_IAB', 'FBIOS', 'Instagram', 'Snapchat', 'LinkedInApp', 'Twitter', 'TikTok',
    'musical_ly', 'BytedanceWebview', 'Pinterest', 'Line/', 'MicroMessenger', 'Threads', 'Barcelona',
  ].join('|'),
);

/**
 * Whether the page is inside another app's own browser (Instagram, Facebook,
 * Snapchat, LinkedIn, Gmail, Telegram and the like). Google refuses to sign
 * anyone in there, and the cookie the invite is kept in belongs to that app's
 * browser, not to the phone's: an account made later in Safari or Chrome would
 * not carry it.
 *
 * Most such apps do not name themselves, so the rule is the web view's own
 * mark (review of 2026-11-10): on an iPhone or iPad every real browser's name
 * ends in `Safari/…` (Safari, Chrome, Firefox and Edge alike) and a web view's
 * does not; Android's web view says `; wv)`. A Chrome Custom Tab or Safari's
 * own sheet inside an app carries no mark, and behaves as the browser.
 */
export function isInAppBrowser(userAgent: string): boolean {
  if (NAMED_IN_APP_BROWSER_PATTERN.test(userAgent)) return true;
  if (/iphone|ipad|ipod/i.test(userAgent)) return !/Safari\//.test(userAgent);
  return /android/i.test(userAgent) && /; wv\)/.test(userAgent);
}

/** What the page puts first for this visitor. */
export type InviteHandoffOffer =
  /** The app keeps the invite: Get the app first, joining here second. */
  | 'app'
  /** Joining here keeps it, the app does not yet: Join first. */
  | 'join'
  /** Neither works inside another app's browser: open the page in the phone's own. */
  | 'open-in-browser'
  /** A laptop: the QR code, beside joining here. */
  | 'qr';

export function inviteHandoffOffer({
  device,
  inAppBrowser,
  preview = false,
  live = INVITE_APP_HANDOFF_LIVE,
}: {
  device: InviteHandoffDevice;
  inAppBrowser: boolean;
  preview?: boolean;
  live?: Readonly<Record<'android' | 'ios', boolean>>;
}): InviteHandoffOffer {
  if (device === 'desktop') return 'qr';
  if (preview || live[device]) return 'app';
  return inAppBrowser ? 'open-in-browser' : 'join';
}

/**
 * Whether the app-first page is shown only because of the preview switch, so
 * it must say that the app in the stores cannot keep the invite yet. False on
 * a platform already live, where that note would be untrue.
 */
export function inviteHandoffPreviewOnly({
  device,
  preview,
  live = INVITE_APP_HANDOFF_LIVE,
}: {
  device: InviteHandoffDevice;
  preview: boolean;
  live?: Readonly<Record<'android' | 'ios', boolean>>;
}): boolean {
  return preview && device !== 'desktop' && !live[device];
}

/** The sign-up page, returning to the page the invite led to once the account is made. */
export function inviteJoinPath(handoff: Pick<InviteInstallHandoff, 'kind' | 'path'>): string {
  return `/login?mode=signup&next=${encodeURIComponent(normalizeInviteHandoffPath(handoff.path, handoff.kind))}`;
}

/**
 * An Android link that opens `url` in Chrome from inside another app's browser,
 * and, on a phone with no Chrome to open, loads it where the visitor is
 * (`S.browser_fallback_url`): a tap never does nothing. Null for anything but
 * an https link.
 */
export function androidOpenInChromeUrl(url: string): string | null {
  if (!url.startsWith('https://')) return null;
  const hashIndex = url.indexOf('#');
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  return `intent://${withoutHash.slice('https://'.length)}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(withoutHash)};end`;
}

/** The invite this tab holds for a hand-off, so a reload of the page still offers it. */
export const INVITE_HANDOFF_STORAGE_KEY = 'mb.invite-handoff.v1';
/** Set when the visitor closed the offer: it stays closed for the tab. */
export const INVITE_HANDOFF_DISMISSED_KEY = 'mb.invite-handoff-dismissed.v1';

type TabStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function tabStorage(): TabStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export type StoredInviteHandoff = InviteInstallHandoff & { preview: boolean };

export function readStoredInviteHandoff(storage: TabStorage | null = tabStorage()): StoredInviteHandoff | null {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(storage?.getItem(INVITE_HANDOFF_STORAGE_KEY) ?? 'null');
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const value = parsed as { code?: unknown; kind?: unknown; path?: unknown; preview?: unknown };
  const code = normalizeInviteShareCode(value.code);
  if (!code) return null;
  const kind: InviteHandoffKind = value.kind === 'invite' ? 'invite' : 'shared_link';
  // Never the preview switch: it is for the page it was opened on, not for the tab.
  return { code, kind, path: normalizeInviteHandoffPath(value.path, kind), preview: false };
}

export function storeInviteHandoff(handoff: StoredInviteHandoff, storage: TabStorage | null = tabStorage()): void {
  try {
    storage?.setItem(INVITE_HANDOFF_STORAGE_KEY, JSON.stringify({ code: handoff.code, kind: handoff.kind, path: handoff.path }));
  } catch {
    // A browser with no storage to give: the offer lasts until the page is reloaded.
  }
}

export function clearStoredInviteHandoff(storage: TabStorage | null = tabStorage()): void {
  try {
    storage?.removeItem(INVITE_HANDOFF_STORAGE_KEY);
  } catch {
    // Nothing was kept.
  }
}

export function inviteHandoffDismissed(storage: TabStorage | null = tabStorage()): boolean {
  try {
    return storage?.getItem(INVITE_HANDOFF_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function dismissInviteHandoff(storage: TabStorage | null = tabStorage()): void {
  try {
    storage?.setItem(INVITE_HANDOFF_DISMISSED_KEY, '1');
  } catch {
    // Closed for this page only.
  }
}

/** Whether the page was opened with the preview switch (`?handoff=preview`). */
export function readInviteHandoffPreview(search: string | null | undefined): boolean {
  if (!search) return false;
  const query = search.startsWith('?') ? search.slice(1) : search;
  return query.split('&').includes(`${INVITE_HANDOFF_PREVIEW_PARAM}=${INVITE_HANDOFF_PREVIEW_VALUE}`);
}

/**
 * `link` (a path with its query and fragment) without the preview switch. The
 * page takes it off the address as it reads it, so an address copied from a
 * preview shows the next person the page as it is today (review of 2026-11-10).
 */
export function withoutInviteHandoffPreview(link: string): string {
  const hashIndex = link.indexOf('#');
  const hash = hashIndex >= 0 ? link.slice(hashIndex) : '';
  const withoutHash = hashIndex >= 0 ? link.slice(0, hashIndex) : link;
  const queryIndex = withoutHash.indexOf('?');
  if (queryIndex < 0) return link;
  const pairs = withoutHash.slice(queryIndex + 1).split('&')
    .filter((pair) => pair !== '' && pair.split('=')[0] !== INVITE_HANDOFF_PREVIEW_PARAM);
  return `${withoutHash.slice(0, queryIndex)}${pairs.length > 0 ? `?${pairs.join('&')}` : ''}${hash}`;
}

/** Leaves the page for a store's listing. Its own function so a test can watch it go. */
export function openStoreListing(url: string): void {
  window.location.assign(url);
}
