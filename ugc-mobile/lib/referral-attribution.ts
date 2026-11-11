import * as SecureStore from 'expo-secure-store';

import type { MagicbookletApiClient } from './api-client';
import {
  TYPED_INVITE_CODE_FAILED,
  TYPED_INVITE_CODE_INVALID,
  TYPED_INVITE_CODE_NOT_FOUND,
  normalizeInviteShortCode,
  readTypedInviteCode,
  typedInviteSavedMessage,
} from './invite-share-link/invite-typed-code';
import type { ReferralClaimResponse, ReferralProgramSummary } from './types';

const PENDING_REFERRAL_STORAGE_KEY = 'magicbooklet.referral.pending.v1';
const RECENT_REFERRAL_CLAIM_STORAGE_KEY = 'magicbooklet.referral.recentClaim.v1';
// How long this device keeps a code the server has not verified yet. Such a
// code has no expiry of its own; once a visit is recorded, the visit's
// `expiresAt` (the program's attribution window) is the only limit, so a
// program with a longer window is not cut short here.
const UNVERIFIED_REFERRAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RECENT_CLAIM_WINDOW_MS = 15 * 60 * 1000;
const REFERRAL_CODE_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;

/** How an invite reached this phone: an invite link, a shared post or profile link, or a typed code. */
export type PendingReferralKind = 'invite' | 'shared_link' | 'code';

export interface PendingReferral {
  /** The invite's link code once its visit is recorded; before that, what was opened. */
  code: string;
  /** The invite's six-character code, once the server has named it. */
  shortCode?: string;
  capturedAt: string;
  /**
   * How it was captured: an invite link (absent on one saved before this was
   * recorded), a shared post or profile link, or a code typed on the sign-in
   * page. An invite link opened later replaces a shared link's invite; a typed
   * code replaces any other; nothing else replaces anything.
   */
  kind?: PendingReferralKind;
  visitToken?: string;
  expiresAt?: string;
  /**
   * The terms the server sent with the recorded visit, the program the visit
   * is bound to. Kept so the landing can name them on a later launch, when the
   * visit is not recorded again. Null or absent until then, or from an older
   * server.
   */
  program?: ReferralProgramSummary | null;
}

export interface RecentReferralClaim {
  code: string;
  claimedAt: string;
  /** The account that made the claim, so another account on the phone is never told of it. */
  userId?: string;
  response: ReferralClaimResponse;
  /** The terms of the invite the claim used, for the landing's "Invite applied". */
  program?: ReferralProgramSummary | null;
}

type ReferralStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

type ReferralApi = Pick<MagicbookletApiClient, 'recordReferralVisit' | 'claimReferral'>;

const defaultStorage: ReferralStorage = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  removeItem: (key) => SecureStore.deleteItemAsync(key),
};
const claimPromises = new WeakMap<ReferralStorage, Promise<ReferralClaimResponse | null>>();

function referralCodeFromUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'magicbooklet.com') return null;
    const match = url.pathname.match(/^\/r\/([^/]+)\/?$/);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * The program's terms when all three are usable, else null. The server prints
 * a missing value as 0, which no screen should repeat as "0%".
 */
export function readReferralProgram(value: unknown): ReferralProgramSummary | null {
  if (!value || typeof value !== 'object') return null;
  const program = value as Partial<ReferralProgramSummary>;
  return isPositiveNumber(program.inviterPercent)
    && isPositiveNumber(program.inviteeFirstPurchasePercent)
    && isPositiveNumber(program.attributionWindowDays)
    ? {
      inviterPercent: program.inviterPercent,
      inviteeFirstPurchasePercent: program.inviteeFirstPurchasePercent,
      attributionWindowDays: program.attributionWindowDays,
    }
    : null;
}

/** "7%", or null while the percent is not known. */
export function formatReferralPercent(percent: number | null | undefined) {
  return isPositiveNumber(percent) ? `${Math.round(percent * 100) / 100}%` : null;
}

/**
 * "7% bonus credits", or "bonus credits" while the terms are unknown: the
 * screens print the server's numbers or none, never numbers of their own.
 */
export function bonusCreditsPhrase(percent: number | null | undefined) {
  const label = formatReferralPercent(percent);
  return label ? `${label} bonus credits` : 'bonus credits';
}

export function normalizeReferralCode(value: string | null | undefined) {
  const candidate = value?.trim();
  if (!candidate) return null;
  const code = candidate.includes('://') ? referralCodeFromUrl(candidate) : candidate;
  return code && REFERRAL_CODE_PATTERN.test(code) ? code : null;
}

function isPendingReferral(value: unknown): value is PendingReferral {
  if (!value || typeof value !== 'object') return false;
  const pending = value as Partial<PendingReferral>;
  return Boolean(
    normalizeReferralCode(pending.code)
    && typeof pending.capturedAt === 'string'
    && (!pending.visitToken || typeof pending.visitToken === 'string')
    && (!pending.expiresAt || typeof pending.expiresAt === 'string')
    && (!pending.shortCode || typeof pending.shortCode === 'string')
    && (!pending.kind || pending.kind === 'invite' || pending.kind === 'shared_link' || pending.kind === 'code')
  );
}

function isExpired(pending: PendingReferral, now: number) {
  const capturedAt = Date.parse(pending.capturedAt);
  if (!Number.isFinite(capturedAt)) return true;
  if (!pending.expiresAt) return capturedAt + UNVERIFIED_REFERRAL_RETENTION_MS <= now;
  const expiresAt = Date.parse(pending.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

export async function getPendingReferral(
  storage: ReferralStorage = defaultStorage,
  now = Date.now()
): Promise<PendingReferral | null> {
  const serialized = await storage.getItem(PENDING_REFERRAL_STORAGE_KEY);
  if (!serialized) return null;

  try {
    const pending: unknown = JSON.parse(serialized);
    if (!isPendingReferral(pending) || isExpired(pending, now)) {
      await storage.removeItem(PENDING_REFERRAL_STORAGE_KEY);
      return null;
    }
    return { ...pending, program: readReferralProgram(pending.program) };
  } catch {
    await storage.removeItem(PENDING_REFERRAL_STORAGE_KEY);
    return null;
  }
}

export async function clearPendingReferral(storage: ReferralStorage = defaultStorage) {
  await storage.removeItem(PENDING_REFERRAL_STORAGE_KEY);
}

/**
 * The claim this account made for this code in the last few minutes, with the
 * terms it used: what the invite's landing shows when it comes back after a
 * sign-up. Only to the account that made it. The record is the phone's, and
 * iOS keeps SecureStore through an uninstall, so a guest on a fresh install
 * that opened the same invite was told "Invite applied" with no account at all
 * (iPhone 16e, 0.1.9 (61), 2026-11-11). Another account's record is left for
 * it, as `getLatestReferralClaimRecord` leaves it.
 */
export async function getRecentReferralClaimRecord(
  code: string,
  userId: string | null | undefined,
  storage: ReferralStorage = defaultStorage,
  now = Date.now()
): Promise<RecentReferralClaim | null> {
  if (!userId) return null;
  const serialized = await storage.getItem(RECENT_REFERRAL_CLAIM_STORAGE_KEY);
  if (!serialized) return null;

  try {
    const recent = JSON.parse(serialized) as Partial<RecentReferralClaim>;
    const claimedAt = typeof recent.claimedAt === 'string' ? Date.parse(recent.claimedAt) : Number.NaN;
    if (
      recent.code !== code
      || !recent.response?.success
      || typeof recent.claimedAt !== 'string'
      || !Number.isFinite(claimedAt)
      || claimedAt + RECENT_CLAIM_WINDOW_MS <= now
    ) {
      await storage.removeItem(RECENT_REFERRAL_CLAIM_STORAGE_KEY);
      return null;
    }
    if (recent.userId !== userId) return null;
    return {
      code,
      userId,
      claimedAt: recent.claimedAt,
      response: recent.response,
      program: readReferralProgram(recent.program),
    };
  } catch {
    await storage.removeItem(RECENT_REFERRAL_CLAIM_STORAGE_KEY);
    return null;
  }
}

/**
 * The claim this phone recorded in the last few minutes, whichever invite it
 * was: what the welcome card says after a sign-up ("Invite applied"), since
 * the claim itself runs unseen as the account is made (`lib/auth.tsx`). Left
 * in place for the invite's own landing to read.
 */
export async function getLatestReferralClaimRecord(
  userId: string | null | undefined,
  storage: ReferralStorage = defaultStorage,
  now = Date.now()
): Promise<RecentReferralClaim | null> {
  if (!userId) return null;
  const serialized = await storage.getItem(RECENT_REFERRAL_CLAIM_STORAGE_KEY).catch(() => null);
  if (!serialized) return null;
  try {
    const recent = JSON.parse(serialized) as Partial<RecentReferralClaim>;
    const claimedAt = typeof recent.claimedAt === 'string' ? Date.parse(recent.claimedAt) : Number.NaN;
    // Only this account's own claim: two sign-ups on one phone within the
    // window must not tell the second of the first's invite (review of #766).
    if (
      typeof recent.code !== 'string'
      || recent.userId !== userId
      || !recent.response?.success
      || !Number.isFinite(claimedAt)
      || claimedAt + RECENT_CLAIM_WINDOW_MS <= now
    ) {
      return null;
    }
    return {
      code: recent.code,
      userId,
      claimedAt: recent.claimedAt as string,
      response: recent.response,
      program: readReferralProgram(recent.program),
    };
  } catch {
    return null;
  }
}

/**
 * What the welcome card says of the claim a sign-up made, in the web's words
 * (`describeReferralClaim`, which a web sign-up's greeting page shows): applied,
 * held for a check, or why not. Null without a claim.
 */
export function inviteClaimLine(
  claim: Pick<RecentReferralClaim, 'response' | 'program'> | null,
): { tone: 'success' | 'info'; text: string } | null {
  if (!claim) return null;
  const { response } = claim;
  if (response.claimed && response.held) {
    return { tone: 'info', text: 'Invite received: its bonus is on hold while we check it. Contact support if you think this is a mistake.' };
  }
  if (response.claimed) {
    return { tone: 'success', text: `Invite applied: your first credit-pack purchase gets ${bonusCreditsPhrase(claim.program?.inviteeFirstPurchasePercent)}.` };
  }
  switch (response.reason) {
    case 'existing_account':
      return { tone: 'info', text: 'Invite not applied: invite bonuses are for new accounts only.' };
    case 'self_referral':
      return { tone: 'info', text: 'Invite not applied: you cannot use your own invite.' };
    case 'already_attributed':
      return { tone: 'info', text: 'Invite not applied: this account already has an inviter.' };
    case 'visit_unavailable':
      return { tone: 'info', text: 'Invite not applied: this invite is no longer active. It may have expired or already been used.' };
    default:
      return { tone: 'info', text: 'Invite not applied: this account is not eligible for this invite.' };
  }
}

export async function getRecentReferralClaim(
  code: string,
  userId: string | null | undefined,
  storage: ReferralStorage = defaultStorage,
  now = Date.now()
): Promise<ReferralClaimResponse | null> {
  return (await getRecentReferralClaimRecord(code, userId, storage, now))?.response ?? null;
}

export async function capturePendingReferral(
  api: ReferralApi,
  rawCode: string,
  options: { storage?: ReferralStorage; now?: number; next?: string; kind?: PendingReferralKind } = {}
) {
  const storage = options.storage ?? defaultStorage;
  const now = options.now ?? Date.now();
  const kind = options.kind ?? 'invite';
  const requestedCode = kind === 'code' ? readTypedInviteCode(rawCode) : normalizeReferralCode(rawCode);
  if (!requestedCode) {
    throw new Error(kind === 'code' ? TYPED_INVITE_CODE_INVALID : 'Enter a valid Magicbooklet invite code.');
  }

  const existing = await getPendingReferral(storage, now);
  if (kind === 'code') return captureTypedCode(api, requestedCode, existing, { storage, now, next: options.next });

  // Someone who followed a shared post and then opens a friend's invite link
  // chose that friend: the invite replaces the shared link's, as the server
  // does for a browser (create_referral_visit). A shared link replaces
  // nothing, and an invite never replaces an invite (review of 2026-11-10).
  const replaces = Boolean(
    existing
    && kind === 'invite'
    && existing.kind === 'shared_link'
    && existing.code !== requestedCode
  );
  const pending: PendingReferral = existing && !replaces
    ? existing
    : { code: requestedCode, capturedAt: new Date(now).toISOString(), kind };

  if (!existing || replaces) {
    // Save the code before making a network request so attribution survives an
    // offline launch, app restart, or an authentication hand-off.
    await storage.setItem(PENDING_REFERRAL_STORAGE_KEY, JSON.stringify(pending));
  }

  if (pending.visitToken) {
    return { pending, keptEarlierInvite: pending.code !== requestedCode };
  }
  const recordingCode = pending.code;

  let visit: Awaited<ReturnType<ReferralApi['recordReferralVisit']>>;
  try {
    visit = await api.recordReferralVisit({
      code: pending.code,
      source: 'mobile',
      kind: pending.kind ?? 'invite',
      ...(options.next ? { next: options.next } : {}),
    });
  } catch (error) {
    if (isTerminalVisitError(error)) {
      await clearPendingReferral(storage);
    }
    throw error;
  }
  // An invite recorded meanwhile by another capture (a code typed on the
  // sign-in page while this one waited on the network) stays: it is newer, and
  // the screen that saved it has already said so (review of #766).
  const current = await getPendingReferral(storage, now).catch(() => null);
  if (current?.visitToken && current.code !== recordingCode) {
    return { pending: current, keptEarlierInvite: current.code !== requestedCode };
  }
  const shortCode = normalizeInviteShortCode(visit.shortCode);
  const recorded: PendingReferral = {
    ...pending,
    code: visit.code,
    ...(shortCode ? { shortCode } : {}),
    visitToken: visit.visitToken,
    expiresAt: visit.expiresAt,
    program: readReferralProgram(visit.program),
  };
  await storage.setItem(PENDING_REFERRAL_STORAGE_KEY, JSON.stringify(recorded));

  return { pending: recorded, keptEarlierInvite: recorded.code !== requestedCode };
}

/**
 * A code typed on the sign-in page (owner, 2026-11-11): it replaces any invite
 * this phone holds, unless it is that invite's own code. The server decides
 * which, as it does for a browser: the held visit's token goes with the code,
 * and the answer is the visit kept, the held one or a new one. Unlike a link it
 * is saved only once the server has answered: the person is there to try
 * again, and a wrong or unknown code must leave the invite they had in place.
 *
 * It is kept on the phone as an invite's: the same rules hold for it here (a
 * later invite link or shared link replaces neither), and a bundle from before
 * typed codes, which an update rolled back to would run, can still read it.
 */
async function captureTypedCode(
  api: ReferralApi,
  typedCode: string,
  existing: PendingReferral | null,
  options: { storage: ReferralStorage; now: number; next?: string },
) {
  const visit = await api.recordReferralVisit({
    code: typedCode,
    source: 'mobile',
    kind: 'code',
    ...(existing?.visitToken ? { visitToken: existing.visitToken } : {}),
    ...(options.next ? { next: options.next } : {}),
  });
  const shortCode = normalizeInviteShortCode(visit.shortCode);
  const recorded: PendingReferral = {
    code: visit.code,
    ...(shortCode ? { shortCode } : {}),
    capturedAt: existing?.visitToken === visit.visitToken ? existing.capturedAt : new Date(options.now).toISOString(),
    kind: 'invite',
    visitToken: visit.visitToken,
    expiresAt: visit.expiresAt,
    program: readReferralProgram(visit.program),
  };
  await options.storage.setItem(PENDING_REFERRAL_STORAGE_KEY, JSON.stringify(recorded));
  return { pending: recorded, keptEarlierInvite: false };
}

export type TypedInviteCodeResult =
  | { ok: true; message: string; pending: PendingReferral }
  | { ok: false; message: string };

/**
 * Saves what someone typed into "Have an invite code?" and says how it went,
 * in the words the web's sign-in page uses (`invite-typed-code.ts`). Never
 * throws.
 */
export async function saveTypedInviteCode(
  api: ReferralApi,
  text: string,
  options: { storage?: ReferralStorage; now?: number } = {},
): Promise<TypedInviteCodeResult> {
  if (!readTypedInviteCode(text)) return { ok: false, message: TYPED_INVITE_CODE_INVALID };
  try {
    const { pending } = await capturePendingReferral(api, text, { ...options, kind: 'code' });
    return {
      ok: true,
      message: typedInviteSavedMessage(pending.program?.inviteeFirstPurchasePercent),
      pending,
    };
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'status' in error
      ? Number((error as { status?: unknown }).status)
      : 0;
    if (status === 400 || status === 404) return { ok: false, message: TYPED_INVITE_CODE_NOT_FOUND };
    if (status === 429) return { ok: false, message: 'Too many tries. Wait a few minutes, then try again.' };
    return { ok: false, message: TYPED_INVITE_CODE_FAILED };
  }
}

/**
 * Records the visit of an invite this phone saved but could not record (it was
 * captured offline, or the server was busy). A visit must exist before the
 * account is made, or the claim refuses the account as not new, so this runs
 * whenever the app comes back while nobody is signed in. Never throws.
 */
export async function retryPendingReferralVisit(
  api: ReferralApi,
  options: { storage?: ReferralStorage; now?: number } = {},
): Promise<void> {
  const storage = options.storage ?? defaultStorage;
  const pending = await getPendingReferral(storage, options.now ?? Date.now()).catch(() => null);
  if (!pending || pending.visitToken) return;
  await capturePendingReferral(api, pending.code, { storage, now: options.now, kind: pending.kind ?? 'invite' })
    .catch(() => undefined);
}

function isTerminalVisitError(error: unknown) {
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : 0;
  return status === 400 || status === 404 || status === 410 || status === 422;
}

function isTerminalClaimError(error: unknown) {
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : 0;
  return status === 400 || status === 403 || status === 404 || status === 409 || status === 410 || status === 422;
}

export async function claimPendingReferral(
  api: ReferralApi,
  options: { storage?: ReferralStorage; now?: number; userId?: string } = {}
): Promise<ReferralClaimResponse | null> {
  const storage = options.storage ?? defaultStorage;
  const inFlight = claimPromises.get(storage);
  if (inFlight) return inFlight;

  const claim = (async () => {
    const pending = await getPendingReferral(storage, options.now);
    if (!pending) return null;

    if (!pending.visitToken) {
      throw new Error('Connect to the internet and retry the invite before creating your account.');
    }

    try {
      const response = await api.claimReferral({
        code: pending.code,
        visitToken: pending.visitToken,
      });
      const recentClaim: RecentReferralClaim = {
        code: pending.code,
        ...(options.userId ? { userId: options.userId } : {}),
        claimedAt: new Date(options.now ?? Date.now()).toISOString(),
        response,
        program: pending.program ?? null,
      };
      await storage.setItem(RECENT_REFERRAL_CLAIM_STORAGE_KEY, JSON.stringify(recentClaim));
      await clearPendingReferral(storage);
      return response;
    } catch (error) {
      if (isTerminalClaimError(error)) {
        await clearPendingReferral(storage);
      }
      throw error;
    }
  })();

  claimPromises.set(storage, claim);
  try {
    return await claim;
  } finally {
    if (claimPromises.get(storage) === claim) claimPromises.delete(storage);
  }
}
