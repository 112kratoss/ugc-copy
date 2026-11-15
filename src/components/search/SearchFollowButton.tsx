'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { pushToast } from '@/components/feedback-state';
import { supabase } from '@/lib/supabase';

import {
  SEARCH_FOLLOWING_LABEL,
  SEARCH_FOLLOW_FAILED,
  SEARCH_FOLLOW_LABEL,
  searchFollowButtonLabel,
} from './search-ui-words';

export type SearchFollowCreator = {
  id: string;
  username: string;
  displayName: string;
  isFollowing: boolean;
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
  const { following } = state;

  const press = async () => {
    if (pending) return;
    let session = null;
    try {
      ({ data: { session } } = await supabase.auth.getSession());
    } catch {
      session = null;
    }
    if (!session || session.user.is_anonymous === true) {
      router.push(`/login?returnUrl=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`);
      return;
    }
    if (session.user.id === creator.id) return;
    const next = !following;
    setState((current) => ({ ...current, following: next }));
    setPending(true);
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
      onChange?.(creator.id, confirmed);
    } catch {
      setState((current) => ({ ...current, following: !next }));
      pushToast({ tone: 'error', message: SEARCH_FOLLOW_FAILED });
    } finally {
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
