import AsyncStorage from '@react-native-async-storage/async-storage';
import { requireOptionalNativeModule } from 'expo';

import {
  normalizeInviteHandoffPath,
  readInviteHandoffLink,
  readInviteInstallReferrer,
  type InviteInstallHandoff,
} from './invite-share-link/invite-install-handoff';
import { INVITE_SHARE_QUERY_PARAM } from './invite-share-link/invite-share-link';
import { capturePendingReferral, getPendingReferral } from './referral-attribution';

/**
 * The app's half of carrying an invite through an install (the cross-device
 * plan, owner 2026-11-10; the formats are the web's too,
 * `lib/invite-share-link/invite-install-handoff.ts`).
 *
 * Someone who opened an invite on the web and then installed the app arrives
 * with nothing: the link opened a browser, not the app. So once per install,
 * for a phone no account has signed in on, the app looks for the invite the
 * web handed it:
 *
 * - **Android** reads the install referrer Google Play kept through the
 *   install. It is exact, needs no tap and shows nothing.
 * - **iPhone** has no such thing. The web copied the invite's link before it
 *   opened the App Store, so on a fresh install the app asks the system
 *   whether a link is waiting on the clipboard (a question that reads nothing
 *   and shows no prompt) and, if one is, offers Apple's own Paste button. The
 *   clipboard is read only by that tap, and by the system, not by this code.
 *
 * What it finds is recorded first, as the page's own capture would record it,
 * and then the app opens the screen the link would have opened had the app
 * been installed: that screen finds the visit already made and makes no second.
 *
 * This runs at the first launch, which runs the code built into the binary:
 * an over-the-air update reaches a phone only from its second launch. So it
 * works for new installs from the store build that carries it.
 */

/** Set once this install has looked for a handed-over invite, whatever it found. */
export const INSTALL_HANDOFF_STORAGE_KEY = 'magicbooklet.invite.install-handoff.v1';

/** How long after installing an iPhone still looks at the clipboard: the copy was made minutes before. */
export const INSTALL_HANDOFF_FRESH_INSTALL_MS = 24 * 60 * 60 * 1000;

export type InstallHandoffStep =
  /** Something is not known yet: the session, this phone's records, the install time. */
  | 'wait'
  /** Not this phone: it has looked before, or an account has signed in on it. */
  | 'skip'
  | 'read-referrer'
  | 'check-clipboard';

export function decideInstallHandoff({
  platform,
  settled,
  authLoading,
  hasUser,
  neverSignedIn,
  installedAt,
  now,
}: {
  platform: string;
  /** null while the stored flag is being read. */
  settled: boolean | null;
  authLoading: boolean;
  hasUser: boolean;
  /** No account has signed in on this phone (`lib/welcome-promise.ts`); null while that is read. */
  neverSignedIn: boolean | null;
  /** iPhone only: when the app was installed; undefined while it is read, null when it cannot be. */
  installedAt?: number | null;
  now: number;
}): InstallHandoffStep {
  if (settled === null || authLoading || neverSignedIn === null) return 'wait';
  // An account can never be invited (`claim_referral_visit` answers `existing_account`).
  if (settled || hasUser || !neverSignedIn) return 'skip';
  if (platform === 'android') return 'read-referrer';
  if (platform !== 'ios') return 'skip';
  if (installedAt === undefined) return 'wait';
  if (installedAt === null || now - installedAt > INSTALL_HANDOFF_FRESH_INSTALL_MS || now < installedAt) return 'skip';
  return 'check-clipboard';
}

/**
 * The screen the handed-over link would have opened in the app: the invite's
 * landing for an invite link, the post or the creator page with the invite on
 * it for a shared link. Each records the invite as it opens, so a capture that
 * failed here is tried again there.
 */
export function inviteHandoffRoute(handoff: InviteInstallHandoff): string {
  const path = normalizeInviteHandoffPath(handoff.path, handoff.kind);
  if (handoff.kind === 'invite' || path === '/') {
    return `/r/${handoff.code}${path === '/' ? '' : `?next=${encodeURIComponent(path)}`}`;
  }
  return `${path}?${INVITE_SHARE_QUERY_PARAM}=${handoff.code}`;
}

/** What became of a handed-over invite once the app tried to record it. */
export type InstallHandoffOutcome =
  /** Recorded: this invite is the one the phone holds. */
  | 'kept'
  /** The phone already held another invite, and that one stays (an invite link replaces only a shared link's). */
  | 'kept-earlier'
  /** The server refused the code (unknown, switched off): nothing is held. */
  | 'unavailable'
  /** Not recorded yet (offline, slow): the code is saved on the phone and recorded at the next try. */
  | 'saved';

/** How long the hand-off waits for the visit before it carries on with the code saved. */
export const INSTALL_HANDOFF_RECORD_TIMEOUT_MS = 4000;

type ReferralApi = Parameters<typeof capturePendingReferral>[0];

/**
 * Records a handed-over invite, once, and says what became of it. The visit is
 * made here and only here: the screen opened afterwards finds it on the phone.
 */
export async function recordInstallHandoff(
  api: ReferralApi,
  handoff: InviteInstallHandoff,
  {
    capture = capturePendingReferral,
    pending = getPendingReferral,
    timeoutMs = INSTALL_HANDOFF_RECORD_TIMEOUT_MS,
  }: {
    capture?: typeof capturePendingReferral;
    pending?: typeof getPendingReferral;
    timeoutMs?: number;
  } = {},
): Promise<InstallHandoffOutcome> {
  const attempt = (async (): Promise<InstallHandoffOutcome> => {
    try {
      const { keptEarlierInvite } = await capture(api, handoff.code, { next: handoff.path, kind: handoff.kind });
      return keptEarlierInvite ? 'kept-earlier' : 'kept';
    } catch {
      // A code the server refused is taken off the phone; anything else stays saved for the next try.
      const held = await pending().catch(() => null);
      return held ? 'saved' : 'unavailable';
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<InstallHandoffOutcome>((resolve) => {
    timer = setTimeout(() => resolve('saved'), timeoutMs);
  });
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether the app goes to the invite's screen once it is recorded.
 *
 * Never when the screen in front already shows that invite (the link itself
 * opened the app after the install). An invite Play carried arrives unasked,
 * so it moves only an app still on the screen it opened on, Home: someone a
 * link took elsewhere stays there. A paste was asked for, and goes.
 */
export function shouldOpenHandoffScreen({
  via,
  handoff,
  pathname,
  shownInvite,
}: {
  via: 'referrer' | 'paste';
  handoff: InviteInstallHandoff;
  /** The screen in front, as `usePathname()` names it. */
  pathname: string | null | undefined;
  /** The `r` of the screen in front, if it has one. */
  shownInvite: string | null | undefined;
}): boolean {
  if (shownInvite === handoff.code || pathname === `/r/${handoff.code}`) return false;
  return via === 'paste' || pathname === '/';
}

/** The invite in what the Paste button handed over, or null: only a link to this site counts. */
export function readPastedInvite(pasted: { type?: unknown; text?: unknown } | null | undefined): InviteInstallHandoff | null {
  if (!pasted || pasted.type !== 'text') return null;
  return readInviteHandoffLink(pasted.text);
}

type Storage = Pick<typeof AsyncStorage, 'getItem' | 'setItem'>;

/** Whether this install has looked already. A store that cannot be read counts as looked: never ask twice. */
export async function readInstallHandoffSettled(storage: Storage = AsyncStorage): Promise<boolean> {
  try {
    return (await storage.getItem(INSTALL_HANDOFF_STORAGE_KEY)) !== null;
  } catch {
    return true;
  }
}

export async function markInstallHandoffSettled(storage: Storage = AsyncStorage, now = new Date().toISOString()): Promise<void> {
  try {
    await storage.setItem(INSTALL_HANDOFF_STORAGE_KEY, now);
  } catch {
    // Asked again at the next start, where an account or an older install ends it.
  }
}

type NativeApplication = {
  getInstallReferrerAsync?: () => Promise<string>;
  getInstallationTimeAsync?: () => Promise<number>;
};

// expo-application is not a direct dependency: adding it would change package.json, a runtime
// fingerprint input, and cut every installed build off from over-the-air updates. Its native
// module is linked anyway (expo-notifications and expo-auth-session depend on it), as
// `lib/app-version-label.ts` reads it; a build without it finds no invite and carries on.
function nativeApplication(): NativeApplication | null {
  try {
    return requireOptionalNativeModule<NativeApplication>('ExpoApplication');
  } catch {
    return null;
  }
}

/**
 * Android: the invite Google Play carried through the install. `read` is false
 * when Play could not be asked (no Play services, a service not yet connected):
 * the next start asks again.
 */
export async function readInstallReferrerInvite(
  application: NativeApplication | null = nativeApplication(),
): Promise<{ read: boolean; handoff: InviteInstallHandoff | null }> {
  if (!application?.getInstallReferrerAsync) return { read: false, handoff: null };
  try {
    return { read: true, handoff: readInviteInstallReferrer(await application.getInstallReferrerAsync()) };
  } catch {
    return { read: false, handoff: null };
  }
}

/** When the app was installed, in epoch milliseconds, or null when the phone does not say. */
export async function readInstallTime(application: NativeApplication | null = nativeApplication()): Promise<number | null> {
  if (!application?.getInstallationTimeAsync) return null;
  try {
    const installedAt = Number(await application.getInstallationTimeAsync());
    return Number.isFinite(installedAt) && installedAt > 0 ? installedAt : null;
  } catch {
    return null;
  }
}
