'use client';

import clsx from 'clsx';
import { SmilePlus } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';

import {
  SUPPORT_HUB_REACTION_EMOJIS,
  SUPPORT_HUB_WORDS,
  supportHubReactionChips,
  supportHubReactionLabel,
  type SupportHubReactionCounts,
  type SupportHubReactionEmoji,
} from '../../../ugc-mobile/lib/support-hub-policy/support-hub-policy';

const CHIP = 'ui-focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-sm font-semibold tabular-nums transition-colors';
const CHIP_IDLE = 'border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] text-[var(--ui-text-secondary)] hover:bg-[var(--ui-surface-3)] hover:text-[var(--ui-text-primary)]';
const CHIP_MINE = 'border-[var(--ui-primary)] bg-[var(--ui-primary-soft)] text-[var(--ui-text-primary)]';
const REACT_CONTROL = 'ui-focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-full border border-[var(--ui-border-subtle)] px-3 text-sm font-bold text-[var(--ui-text-muted)] transition-colors hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-primary)]';

/**
 * An update's or a roadmap item's reactions, the chat's six quick reactions,
 * one per person (owner, 2026-11-26): a chip for each one somebody chose, with
 * how many did, and React, which offers all six. A press sets, changes or
 * clears the reader's own; the reader's chip is drawn in coral. A reader with
 * no account sees the counts, and each press is a link to sign in, as a
 * visitor's comment Like is.
 */
export default function SupportHubReactions({
  subject,
  reactions,
  myReaction,
  canReact,
  signInHref,
  busy = false,
  onReact,
}: {
  /** What is reacted to, for a screen reader: the update's or the item's title. */
  subject: string;
  reactions: SupportHubReactionCounts;
  myReaction: SupportHubReactionEmoji | null;
  /** A registered account: the presses are reactions. Otherwise they ask for a sign-in. */
  canReact: boolean;
  signInHref: string;
  /** A reaction is on its way: presses wait for its answer. */
  busy?: boolean;
  onReact: (emoji: SupportHubReactionEmoji | null) => void;
}) {
  const chips = supportHubReactionChips(reactions);
  const [open, setOpen] = useState(false);
  const pickerId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // The six close at a press anywhere else on the page.
  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  const choose = (emoji: SupportHubReactionEmoji | null) => {
    if (busy) return;
    onReact(emoji);
  };

  const groupLabel = `Reactions to “${subject}”`;

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={groupLabel}
      aria-busy={busy || undefined}
      className="flex flex-wrap items-center gap-2"
    >
      {chips.map(({ emoji, count }) => {
        const mine = myReaction === emoji;
        const label = supportHubReactionLabel(emoji, count, mine);
        return canReact ? (
          <button
            key={emoji}
            type="button"
            aria-pressed={mine}
            aria-label={label}
            onClick={() => choose(mine ? null : emoji)}
            className={clsx(CHIP, mine ? CHIP_MINE : CHIP_IDLE)}
          >
            <span aria-hidden>{emoji}</span>
            <span aria-hidden>{count.toLocaleString('en-US')}</span>
          </button>
        ) : (
          <Link
            key={emoji}
            href={signInHref}
            prefetch={false}
            aria-label={`${label}. ${SUPPORT_HUB_WORDS.signInToReact}`}
            className={clsx(CHIP, CHIP_IDLE)}
          >
            <span aria-hidden>{emoji}</span>
            <span aria-hidden>{count.toLocaleString('en-US')}</span>
          </Link>
        );
      })}

      {canReact ? (
        <>
          <button
            ref={triggerRef}
            type="button"
            aria-expanded={open}
            aria-controls={pickerId}
            onClick={() => setOpen((current) => !current)}
            className={REACT_CONTROL}
          >
            <SmilePlus className="h-4 w-4" aria-hidden />
            {SUPPORT_HUB_WORDS.react}
          </button>
          {open ? (
            <div
              id={pickerId}
              role="group"
              aria-label={SUPPORT_HUB_WORDS.react}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                setOpen(false);
                triggerRef.current?.focus();
              }}
              className="flex items-center gap-1 rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-raised)] p-1"
            >
              {SUPPORT_HUB_REACTION_EMOJIS.map((emoji) => {
                const mine = myReaction === emoji;
                return (
                  <button
                    key={emoji}
                    type="button"
                    aria-pressed={mine}
                    onClick={() => {
                      setOpen(false);
                      triggerRef.current?.focus();
                      choose(mine ? null : emoji);
                    }}
                    className={clsx(
                      'ui-focus-ring flex h-9 w-9 items-center justify-center rounded-full text-lg leading-none transition-colors hover:bg-[var(--ui-surface-3)]',
                      mine && 'bg-[var(--ui-primary-soft)]',
                    )}
                  >
                    {emoji}
                  </button>
                );
              })}
            </div>
          ) : null}
        </>
      ) : (
        <Link href={signInHref} prefetch={false} className={REACT_CONTROL}>
          <SmilePlus className="h-4 w-4" aria-hidden />
          {SUPPORT_HUB_WORDS.signInToReact}
        </Link>
      )}
    </div>
  );
}
