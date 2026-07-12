import * as SecureStore from 'expo-secure-store';

import type { MagicbookletApiClient } from './api-client';
import type { ReferralClaimResponse } from './types';

const PENDING_REFERRAL_STORAGE_KEY = 'magicbooklet.referral.pending.v1';
const RECENT_REFERRAL_CLAIM_STORAGE_KEY = 'magicbooklet.referral.recentClaim.v1';
const DEFAULT_ATTRIBUTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const RECENT_CLAIM_WINDOW_MS = 15 * 60 * 1000;
const REFERRAL_CODE_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;

export interface PendingReferral {
  code: string;
  capturedAt: string;
  visitToken?: string;
  expiresAt?: string;
}

export interface RecentReferralClaim {
  code: string;
  claimedAt: string;
  response: ReferralClaimResponse;
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
  );
}

function isExpired(pending: PendingReferral, now: number) {
  const capturedAt = Date.parse(pending.capturedAt);
  if (!Number.isFinite(capturedAt) || capturedAt + DEFAULT_ATTRIBUTION_WINDOW_MS <= now) return true;
  if (!pending.expiresAt) return false;
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
    return pending;
  } catch {
    await storage.removeItem(PENDING_REFERRAL_STORAGE_KEY);
    return null;
  }
}

export async function clearPendingReferral(storage: ReferralStorage = defaultStorage) {
  await storage.removeItem(PENDING_REFERRAL_STORAGE_KEY);
}

export async function getRecentReferralClaim(
  code: string,
  storage: ReferralStorage = defaultStorage,
  now = Date.now()
): Promise<ReferralClaimResponse | null> {
  const serialized = await storage.getItem(RECENT_REFERRAL_CLAIM_STORAGE_KEY);
  if (!serialized) return null;

  try {
    const recent = JSON.parse(serialized) as Partial<RecentReferralClaim>;
    const claimedAt = typeof recent.claimedAt === 'string' ? Date.parse(recent.claimedAt) : Number.NaN;
    if (
      recent.code !== code
      || !recent.response?.success
      || !Number.isFinite(claimedAt)
      || claimedAt + RECENT_CLAIM_WINDOW_MS <= now
    ) {
      await storage.removeItem(RECENT_REFERRAL_CLAIM_STORAGE_KEY);
      return null;
    }
    return recent.response;
  } catch {
    await storage.removeItem(RECENT_REFERRAL_CLAIM_STORAGE_KEY);
    return null;
  }
}

export async function capturePendingReferral(
  api: ReferralApi,
  rawCode: string,
  options: { storage?: ReferralStorage; now?: number; next?: string } = {}
) {
  const storage = options.storage ?? defaultStorage;
  const now = options.now ?? Date.now();
  const requestedCode = normalizeReferralCode(rawCode);
  if (!requestedCode) {
    throw new Error('Enter a valid Magicbooklet invite code.');
  }

  const existing = await getPendingReferral(storage, now);
  const pending: PendingReferral = existing ?? {
    code: requestedCode,
    capturedAt: new Date(now).toISOString(),
  };

  if (!existing) {
    // Save the code before making a network request so attribution survives an
    // offline launch, app restart, or an authentication hand-off.
    await storage.setItem(PENDING_REFERRAL_STORAGE_KEY, JSON.stringify(pending));
  }

  if (pending.visitToken) {
    return { pending, keptEarlierInvite: pending.code !== requestedCode };
  }

  let visit: Awaited<ReturnType<ReferralApi['recordReferralVisit']>>;
  try {
    visit = await api.recordReferralVisit({
      code: pending.code,
      source: 'mobile',
      ...(options.next ? { next: options.next } : {}),
    });
  } catch (error) {
    if (isTerminalVisitError(error)) {
      await clearPendingReferral(storage);
    }
    throw error;
  }
  const recorded: PendingReferral = {
    ...pending,
    code: visit.code,
    visitToken: visit.visitToken,
    expiresAt: visit.expiresAt,
  };
  await storage.setItem(PENDING_REFERRAL_STORAGE_KEY, JSON.stringify(recorded));

  return { pending: recorded, keptEarlierInvite: recorded.code !== requestedCode };
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
  options: { storage?: ReferralStorage; now?: number } = {}
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
        claimedAt: new Date(options.now ?? Date.now()).toISOString(),
        response,
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
