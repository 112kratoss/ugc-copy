'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Share2 } from 'lucide-react';

import { sharePublicGeneration } from '@/lib/share-client';
import type { GenerationShareSourceSurface } from '@/lib/share';

interface PublicShareButtonProps {
  generationId: string;
  title: string;
  description?: string | null;
  sourceSurface: GenerationShareSourceSurface;
  accessToken?: string | null;
  className?: string;
  label?: string;
  disabled?: boolean;
  disabledReason?: string;
  onShared?: () => void;
}

export default function PublicShareButton({
  generationId,
  title,
  description,
  sourceSurface,
  accessToken,
  className,
  label = 'Share',
  disabled = false,
  disabledReason,
  onShared,
}: PublicShareButtonProps) {
  const [state, setState] = useState<'idle' | 'loading' | 'copied' | 'shared' | 'error'>('idle');
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
    }, 2200);
  };

  useEffect(() => clearResetTimer, []);

  const handleClick = async () => {
    if (disabled || state === 'loading') {
      return;
    }

    setState('loading');

    try {
      const channel = await sharePublicGeneration({
        generationId,
        title,
        description,
        sourceSurface,
        accessToken,
      });

      if (!channel) {
        setState('idle');
        return;
      }

      setState(channel === 'copy-link' ? 'copied' : 'shared');
      onShared?.();
      queueReset();
    } catch (error) {
      console.error('Failed to share public generation:', error);
      setState('error');
      queueReset();
    }
  };

  const resolvedLabel =
    state === 'loading'
      ? 'Sharing...'
      : state === 'copied'
        ? 'Copied link'
        : state === 'shared'
          ? 'Shared'
          : state === 'error'
            ? 'Try again'
            : label;

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        void handleClick();
      }}
      disabled={disabled || state === 'loading'}
      title={disabledReason}
      className={className}
    >
      {state === 'loading' ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : state === 'copied' || state === 'shared' ? (
        <Check className="h-4 w-4" />
      ) : (
        <Share2 className="h-4 w-4" />
      )}
      <span>{resolvedLabel}</span>
    </button>
  );
}
