'use client';

import { Check, Loader2, Share2 } from 'lucide-react';

import { useShareAction } from '@/app/components/useShareAction';
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
  iconOnly?: boolean;
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
  iconOnly = false,
}: PublicShareButtonProps) {
  const {
    state,
    isLoading,
    resolvedLabel,
    statusMessage,
    runShareAction,
  } = useShareAction({
    label,
    disabled,
    onShared,
    onAction: () =>
      sharePublicGeneration({
        generationId,
        title,
        description,
        sourceSurface,
        accessToken,
      }),
  });

  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          void runShareAction();
        }}
        disabled={disabled || isLoading}
        aria-busy={isLoading}
        aria-label={iconOnly ? resolvedLabel : undefined}
        title={disabledReason || (iconOnly ? resolvedLabel : undefined)}
        className={className}
      >
        {state === 'loading' ? (
          <Loader2 size={16} className="h-4 w-4 shrink-0 animate-spin" />
        ) : state === 'copied' || state === 'shared' ? (
          <Check size={16} className="h-4 w-4 shrink-0" />
        ) : (
          <Share2 size={16} className="h-4 w-4 shrink-0" />
        )}
        {!iconOnly && <span>{resolvedLabel}</span>}
      </button>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {statusMessage}
      </span>
    </>
  );
}
