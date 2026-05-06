'use client';

import { useEffect, useRef, useState } from 'react';

import type { GenerationShareChannel } from '@/lib/share';

export type ShareActionState = 'idle' | 'loading' | 'copied' | 'shared' | 'error';

interface UseShareActionOptions {
  label: string;
  disabled?: boolean;
  onAction: () => Promise<GenerationShareChannel | null>;
  onShared?: () => void;
}

const RESET_DELAY_MS = 2200;

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
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    if (disabled || state === 'loading') {
      return;
    }

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
      console.error('Failed to share:', error);
      setState('error');
      queueReset();
    }
  };

  return {
    state,
    isLoading: state === 'loading',
    resolvedLabel: getShareActionLabel(state, label),
    statusMessage: getShareActionStatus(state),
    runShareAction,
  };
}
