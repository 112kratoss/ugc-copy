'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';

import type { GenerationShareChannel } from '@/lib/share';
import { copyLinkToClipboard, ShareLinkRefusedError } from '@/lib/share-client';

export type ShareActionState = 'idle' | 'loading' | 'copied' | 'shared' | 'error';

interface UseShareActionOptions {
  label: string;
  disabled?: boolean;
  onAction: () => Promise<GenerationShareChannel | null>;
  onShared?: () => void;
}

/**
 * A share the browser refused both ways, in the sheet to copy by hand: its link, and the count and
 * `onShared` of what it was shared for, kept from the press that shared it. The button can be
 * given another post while the sheet is up (a load moves the reel on); they go with the link.
 */
interface RefusedShare {
  url: string;
  countCopy: () => Promise<void>;
  onShared?: () => void;
}

const RESET_DELAY_MS = 2200;

/**
 * A share button while it shares is busy, not disabled: a focused button that goes disabled gives
 * the focus up, and a keyboard or screen-reader user who pressed Share landed at the top of the
 * page (2026-11-17). It carries `aria-disabled` and takes no press meanwhile (`runShareAction`).
 * Callers dim it with `aria-disabled:` classes, as they did with `disabled:`; this keeps the arrow
 * the app's disabled buttons show, which globals.css gives only to `:disabled`, over its pointer.
 */
export const SHARE_BUSY_STYLE: CSSProperties = { cursor: 'default' };

function getShareActionLabel(state: ShareActionState, label: string) {
  switch (state) {
    case 'loading':
      return 'Sharing...';
    case 'copied':
      return 'Copied link';
    case 'shared':
      return 'Shared';
    case 'error':
      return 'Try again';
    default:
      return label;
  }
}

function getShareActionStatus(state: ShareActionState) {
  switch (state) {
    case 'copied':
      return 'Link copied to clipboard.';
    case 'shared':
      return 'Share sheet completed.';
    case 'error':
      return 'Sharing failed. Try again.';
    default:
      return '';
  }
}

export function useShareAction({
  label,
  disabled = false,
  onAction,
  onShared,
}: UseShareActionOptions) {
  const [state, setState] = useState<ShareActionState>('idle');
  const [refused, setRefused] = useState<RefusedShare | null>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A share under way. The button takes presses while it shares, so they are turned away here,
  // not by the state: a press can come before React has drawn the share as under way.
  const sharingRef = useRef(false);
  // Whether the share in the sheet has been counted: once, by the person's own copy of the link or
  // by Copy link, whichever comes first.
  const refusedCountedRef = useRef(false);

  const clearResetTimer = () => {
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  };

  const queueReset = () => {
    clearResetTimer();
    resetTimerRef.current = setTimeout(() => {
      setState('idle');
      resetTimerRef.current = null;
    }, RESET_DELAY_MS);
  };

  useEffect(() => clearResetTimer, []);

  const runShareAction = async () => {
    if (disabled || sharingRef.current) {
      return;
    }

    sharingRef.current = true;
    // A "Copied link" from the last share must not turn this one back to Share while it runs.
    clearResetTimer();
    setState('loading');

    try {
      const channel = await onAction();

      if (!channel) {
        setState('idle');
        return;
      }

      setState(channel === 'copy-link' ? 'copied' : 'shared');
      onShared?.();
      queueReset();
    } catch (error) {
      if (error instanceof ShareLinkRefusedError) {
        // Not a failure to try again: a second try is refused the same way. The link, to copy.
        setState('idle');
        refusedCountedRef.current = false;
        setRefused({ url: error.url, countCopy: error.countCopy, onShared });
        return;
      }
      console.error('Failed to share:', error);
      setState('error');
      queueReset();
    } finally {
      sharingRef.current = false;
    }
  };

  /** The person has the link the sheet holds: the share, counted once a sheet. */
  const markRefusedLinkCopied = () => {
    if (!refused) {
      return;
    }
    if (!refusedCountedRef.current) {
      refusedCountedRef.current = true;
      void refused.countCopy();
      refused.onShared?.();
    }
    setState('copied');
    queueReset();
  };

  /** The sheet's Copy link: true once the link is on the clipboard. */
  const copyRefusedLink = async () => {
    if (!refused) {
      return false;
    }

    try {
      await copyLinkToClipboard(refused.url);
    } catch (error) {
      console.error('Failed to copy the link:', error);
      return false;
    }

    markRefusedLinkCopied();
    return true;
  };

  return {
    state,
    isLoading: state === 'loading',
    resolvedLabel: getShareActionLabel(state, label),
    statusMessage: getShareActionStatus(state),
    runShareAction,
    refusedLink: refused?.url ?? null,
    copyRefusedLink,
    /** The person's own copy of the sheet's link (Cmd or Ctrl+C, the field's menu): nothing written. */
    countRefusedLinkCopiedByHand: markRefusedLinkCopied,
    dismissRefusedLink: () => setRefused(null),
  };
}
