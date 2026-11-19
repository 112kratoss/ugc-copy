'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';

import { pushToast, requestConfirmation, type ConfirmationRequest } from '@/components/feedback-state';
import { BrowserSupabaseLoadError, readBrowserSession } from '@/lib/browser-session';

import {
  SEARCH_FOLLOWING_LABEL,
  SEARCH_FOLLOW_FAILED,
  SEARCH_FOLLOW_LABEL,
  searchFollowButtonLabel,
} from '../../../ugc-mobile/lib/public-search-policy/search-ui-words';
import { noteFollowChange } from '@/lib/follow-changes';

export type SearchFollowCreator = {
  id: string;
  username: string;
  displayName: string;
  isFollowing: boolean;
};

/** A press whose session could not be read because the client's code did not load. */
export const FOLLOW_UNLOADED: ConfirmationRequest = {
  title: 'Follow did not load',
  message: 'Part of this page did not load. Reload it to follow from here.',
  confirmLabel: 'Reload page',
  cancelLabel: 'Not now',
};

/**
 * Follow on a creator row of search (the owner's search benchmark, 2026-11-15:
 * follow from the list, as Pinterest, X and Instagram let a person do), with
 * the creator page's own request and words (`POST /api/profile/follow`,
 * `ProfileActions`). It follows without leaving the page: the press is
 * answered at once and put back, with the creator page's sentence in a toast,
 * if the server refuses it.
 *
 * A visitor, and a guest session, who follow nobody, are sent to sign in and
 * back to this search, as the creator page's Follow sends them. The button
 * sits beside the row's link, never inside it, so a press on it neither opens
 * the profile nor counts as a result opened (search-open-report.ts reads only
 * the row's link).
 */
export function SearchFollowButton({
  creator,
  onChange,
  className = '',
}: {
  creator: SearchFollowCreator;
  /** Told what the server now has, so the answer the page keeps for Back says it too. */
  onChange?: (creatorId: string, following: boolean) => void;
  className?: string;
}) {
  const router = useRouter();
  // What the answer says, until a press here changes it; an answer that says
  // otherwise later (asked again, kept for Back) is what the server has.
  const [state, setState] = useState({ from: creator.isFollowing, following: creator.isFollowing });
  if (state.from !== creator.isFollowing) setState({ from: creator.isFollowing, following: creator.isFollowing });
  const [pending, setPending] = useState(false);
  // A press under way, from its first moment: a second press while the session is read (behind its
  // lock while a token is refreshed) is the same press, never a second follow (review of #828, N4).
  const pressing = useRef(false);
  const { following } = state;

  const press = async () => {
    if (pressing.current) return;
    pressing.current = true;
    setPending(true);
    try {
      let session: Session | null;
      try {
        // A visitor has none, read without loading the Supabase client.
        session = await readBrowserSession();
      } catch (error) {
        // The session could not be read: that is no sign of being signed out, so nothing changes.
        // The client's code that did not load stays unloaded until a reload in a build
        // (browser-session.ts), so that is what the person is offered; any other failure says the
        // creator page's sentence.
        if (error instanceof BrowserSupabaseLoadError) {
          if (await requestConfirmation(FOLLOW_UNLOADED)) window.location.reload();
          return;
        }
        pushToast({ tone: 'error', message: SEARCH_FOLLOW_FAILED });
        return;
      }
      if (!session || session.user.is_anonymous === true) {
        router.push(`/login?returnUrl=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`);
        return;
      }
      if (session.user.id === creator.id) return;
      const next = !following;
      setState((current) => ({ ...current, following: next }));
      try {
        const response = await fetch('/api/profile/follow', {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ followingId: creator.id, following: next }),
        });
        if (!response.ok) throw new Error('The follow was refused.');
        const data = await response.json().catch(() => null) as { following?: unknown } | null;
        const confirmed = typeof data?.following === 'boolean' ? data.following : next;
        setState((current) => ({ ...current, following: confirmed }));
        // For a page Back restores later (follow-changes.ts), this one included.
        noteFollowChange(session.user.id, creator.id, confirmed);
        onChange?.(creator.id, confirmed);
      } catch {
        setState((current) => ({ ...current, following: !next }));
        pushToast({ tone: 'error', message: SEARCH_FOLLOW_FAILED });
      }
    } finally {
      pressing.current = false;
      setPending(false);
    }
  };

  return (
    <button
      type="button"
      aria-pressed={following}
      aria-busy={pending || undefined}
      aria-label={searchFollowButtonLabel(creator, following)}
      onClick={() => void press()}
      // The creator page's Follow: a white capsule, and once following a quiet one.
      // As wide as its longer word either way, so the row does not move when it changes.
      className={`ui-focus-ring inline-flex min-h-11 min-w-28 shrink-0 items-center justify-center rounded-full px-4 text-sm font-semibold transition-[background-color,color,scale] duration-150 ease-out motion-safe:active:scale-[0.97] ${following
        ? 'border border-white/15 bg-white/[0.08] text-white hover:bg-white/[0.14]'
        : 'bg-white text-black hover:bg-zinc-200'} ${className}`}
    >
      {following ? SEARCH_FOLLOWING_LABEL : SEARCH_FOLLOW_LABEL}
    </button>
  );
}
