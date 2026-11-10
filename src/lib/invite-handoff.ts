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
 * in a change of its own. Until then the page tells a phone to join here first,
 * which keeps the invite today, and says so of the app.
 */
export const INVITE_APP_HANDOFF_LIVE: Readonly<Record<'android' | 'ios', boolean>> = {
  android: false,
  ios: false,
};

/**
 * A link opened with `handoff=preview` is shown the page as it will be once the
 * app keeps a handed-over invite, in that tab only: for checking the store
 * links and the copied link on real phones before the store builds are out.
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

const IN_APP_BROWSER_PATTERN = new RegExp(
  [
    'FBAN', 'FBAV', 'FB_IAB', 'FBIOS', 'Instagram', 'Snapchat', 'LinkedInApp', 'Twitter', 'TikTok',
    'musical_ly', 'BytedanceWebview', 'Pinterest', 'Line/', 'MicroMessenger', 'Threads', 'Barcelona',
  ].join('|'),
);

/**
 * Whether the page is inside another app's own browser (Instagram, Facebook,
 * Snapchat, LinkedIn and the like). Google refuses to sign anyone in there, and
 * the cookie the invite is kept in belongs to that app's browser, not to the
 * phone's: an account made later in Safari or Chrome would not carry it.
 */
export function isInAppBrowser(userAgent: string): boolean {
  if (IN_APP_BROWSER_PATTERN.test(userAgent)) return true;
  // Android's WebView marks itself; a Chrome Custom Tab does not, and behaves as Chrome.
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

/** The sign-up page, returning to `path` once the account is made. */
export function inviteJoinPath(path: string): string {
  return `/login?mode=signup&next=${encodeURIComponent(normalizeInviteHandoffPath(path))}`;
}

/**
 * An Android link that opens `url` in Chrome from inside another app's browser.
 * Null for anything but an https link.
 */
export function androidOpenInChromeUrl(url: string): string | null {
  if (!url.startsWith('https://')) return null;
  const hashIndex = url.indexOf('#');
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  return `intent://${withoutHash.slice('https://'.length)}#Intent;scheme=https;package=com.android.chrome;end`;
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
  return {
    code,
    kind: value.kind === 'invite' ? 'invite' : 'shared_link',
    path: normalizeInviteHandoffPath(value.path),
    preview: value.preview === true,
  };
}

export function storeInviteHandoff(handoff: StoredInviteHandoff, storage: TabStorage | null = tabStorage()): void {
  try {
    storage?.setItem(INVITE_HANDOFF_STORAGE_KEY, JSON.stringify(handoff));
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

/** Leaves the page for a store's listing. Its own function so a test can watch it go. */
export function openStoreListing(url: string): void {
  window.location.assign(url);
}
