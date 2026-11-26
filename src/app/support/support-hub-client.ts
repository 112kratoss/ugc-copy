'use client';

import { useCallback, useRef, useState } from 'react';

import { pushToast } from '@/components/feedback-state';
import { hasSupabaseAuthCookie } from '@/lib/supabase-auth-cookie';

import {
  SUPPORT_HUB_WORDS,
  applySupportHubReaction,
  readSupportHubReactionResponse,
  readSupportRoadmapResponse,
  readSupportUpdatesPage,
  supportHubPath,
  type SupportHubReactionCounts,
  type SupportHubReactionEmoji,
  type SupportHubReactionResponse,
  type SupportHubTab,
  type SupportRoadmapResponse,
  type SupportUpdatesPage,
} from '../../../ugc-mobile/lib/support-hub-policy/support-hub-policy';

/**
 * How Help & Support's Updates and Roadmap talk to the server
 * (`support-hub-route-adapter-service.ts`): the two lists and the reactions.
 *
 * A reader with no session at all, neither a token nor a Supabase session
 * cookie being checked, asks a list as `scope=public`, the answer every visitor
 * gets, which the CDN keeps for a minute (as the comments thread's read,
 * `post-comments-client.ts`); anyone else sends their token, and the answer
 * carries their own reaction. A reaction is an account's: a visitor and a
 * guest are sent to sign in instead.
 */

export const SUPPORT_HUB_SCOPE_PARAM = 'scope';
export const SUPPORT_HUB_PUBLIC_SCOPE = 'public';
export type SupportHubReadScope = typeof SUPPORT_HUB_PUBLIC_SCOPE;

/** Which read a list asks for, at the moment it is sent: the shared one only with no session of any kind. */
export function supportHubReadScope({
  accessToken,
  hasSessionCookie,
}: {
  accessToken: string | null;
  hasSessionCookie: boolean;
}): SupportHubReadScope | null {
  return !accessToken && !hasSessionCookie ? SUPPORT_HUB_PUBLIC_SCOPE : null;
}

/** The Updates list's address: a later page's cursor first, the scope last, always in that order (the shared answer's cache key). */
export function supportUpdatesListPath({ cursor = null, scope = null }: { cursor?: string | null; scope?: SupportHubReadScope | null } = {}): string {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (scope) params.set(SUPPORT_HUB_SCOPE_PARAM, scope);
  const query = params.toString();
  return query ? `/api/support/updates?${query}` : '/api/support/updates';
}

export function supportRoadmapListPath({ scope = null }: { scope?: SupportHubReadScope | null } = {}): string {
  return scope ? `/api/support/roadmap?${SUPPORT_HUB_SCOPE_PARAM}=${scope}` : '/api/support/roadmap';
}

/** Where "Sign in" goes from a tab, and comes back to. */
export function supportHubSignInHref(tab: SupportHubTab): string {
  return `/login?returnUrl=${encodeURIComponent(supportHubPath(tab))}`;
}

/** A list that could not be read: the status it was answered with, or null for no answer. */
export class SupportHubReadError extends Error {
  readonly status: number | null;

  constructor(status: number | null) {
    super(status === null ? 'The list could not be read.' : `The list was answered ${status}.`);
    this.name = 'SupportHubReadError';
    this.status = status;
  }
}

async function readList<T>(
  path: (scope: SupportHubReadScope | null) => string,
  read: (json: unknown) => T | null,
  { accessToken, signal }: { accessToken: string | null; signal?: AbortSignal },
): Promise<T> {
  const scope = supportHubReadScope({ accessToken, hasSessionCookie: hasSupabaseAuthCookie() });
  let response: Response;
  try {
    response = await fetch(path(scope), {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new SupportHubReadError(null);
  }
  if (!response.ok) throw new SupportHubReadError(response.status);
  const value = read(await response.json().catch(() => null));
  if (!value) throw new SupportHubReadError(response.status);
  return value;
}

/** A page of Updates, newest first: the first with no cursor, then each `nextCursor`. */
export function fetchSupportUpdatesPage({
  cursor = null,
  accessToken,
  signal,
}: {
  cursor?: string | null;
  accessToken: string | null;
  signal?: AbortSignal;
}): Promise<SupportUpdatesPage> {
  return readList((scope) => supportUpdatesListPath({ cursor, scope }), readSupportUpdatesPage, { accessToken, signal });
}

export function fetchSupportRoadmap({
  accessToken,
  signal,
}: {
  accessToken: string | null;
  signal?: AbortSignal;
}): Promise<SupportRoadmapResponse> {
  return readList((scope) => supportRoadmapListPath({ scope }), readSupportRoadmapResponse, { accessToken, signal });
}

export type SupportHubReactionTarget = { kind: 'update' | 'roadmap'; id: string };

export type SupportHubReactionResult =
  | { ok: true; value: SupportHubReactionResponse }
  /** `sign-in`: no account behind the request (signed out since, or a guest); `failed`: anything else. */
  | { ok: false; reason: 'sign-in' | 'failed' };

function reactionPath({ kind, id }: SupportHubReactionTarget): string {
  const base = kind === 'update' ? '/api/support/updates' : '/api/support/roadmap';
  return `${base}/${encodeURIComponent(id)}/reaction`;
}

/** Sets the account's reaction (`null` clears it), answered with the counts as they now are. */
export async function sendSupportHubReaction({
  target,
  emoji,
  accessToken,
}: {
  target: SupportHubReactionTarget;
  emoji: SupportHubReactionEmoji | null;
  accessToken: string | null;
}): Promise<SupportHubReactionResult> {
  if (!accessToken) return { ok: false, reason: 'sign-in' };
  try {
    const response = await fetch(reactionPath(target), {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji }),
    });
    const json: unknown = await response.json().catch(() => null);
    const code = json && typeof json === 'object' ? (json as { code?: unknown }).code : undefined;
    // The route answers no account 401; the proxy answers a guest's token 403 REGISTRATION_REQUIRED.
    if (response.status === 401 || (response.status === 403 && code === 'REGISTRATION_REQUIRED')) {
      return { ok: false, reason: 'sign-in' };
    }
    const value = response.ok ? readSupportHubReactionResponse(json) : null;
    return value ? { ok: true, value } : { ok: false, reason: 'failed' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/** What a reaction changes on an update or a roadmap item. */
export type SupportHubReactable = {
  id: string;
  reactions: SupportHubReactionCounts;
  myReaction: SupportHubReactionEmoji | null;
};

/**
 * A press on a reaction, drawn at once (`applySupportHubReaction`) and then
 * replaced by the server's counts, or put back with a toast if the server
 * refuses it. One request per item at a time: a press while one is on its way
 * is not taken.
 */
export function useSupportHubReaction({
  kind,
  getAccessToken,
  patch,
}: {
  kind: SupportHubReactionTarget['kind'];
  /** Read as the request goes, so a token refreshed meanwhile is the one sent. */
  getAccessToken: () => string | null;
  patch: (id: string, change: Pick<SupportHubReactable, 'reactions' | 'myReaction'>) => void;
}) {
  const pendingRef = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());

  const react = useCallback(async (item: SupportHubReactable, next: SupportHubReactionEmoji | null) => {
    if (pendingRef.current.has(item.id)) return;
    pendingRef.current.add(item.id);
    setPending(new Set(pendingRef.current));
    const before = { reactions: item.reactions, myReaction: item.myReaction };
    patch(item.id, { reactions: applySupportHubReaction(before.reactions, before.myReaction, next), myReaction: next });
    try {
      const result = await sendSupportHubReaction({ target: { kind, id: item.id }, emoji: next, accessToken: getAccessToken() });
      if (result.ok) {
        patch(item.id, result.value);
        return;
      }
      patch(item.id, before);
      pushToast({
        tone: 'error',
        message: result.reason === 'sign-in' ? SUPPORT_HUB_WORDS.signInToReact : SUPPORT_HUB_WORDS.reactionFailed,
      });
    } finally {
      pendingRef.current.delete(item.id);
      setPending(new Set(pendingRef.current));
    }
  }, [getAccessToken, kind, patch]);

  return { react, pending };
}
