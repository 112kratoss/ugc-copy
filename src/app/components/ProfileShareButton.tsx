'use client';

import { Check, Loader2, Share2 } from 'lucide-react';

import { useShareAction } from '@/app/components/useShareAction';
import { shareCreatorProfile } from '@/lib/share-client';
import type { ProfileShareSourceSurface } from '@/lib/share';

interface ProfileShareButtonProps {
  username: string;
  displayName: string;
  sourceSurface: ProfileShareSourceSurface;
  accessToken?: string | null;
  className?: string;
  label?: string;
  onShared?: () => void;
}

export default function ProfileShareButton({
  username,
  displayName,
  sourceSurface,
  accessToken,
  className,
  label = 'Share profile',
  onShared,
}: ProfileShareButtonProps) {
  const {
    state,
    isLoading,
    resolvedLabel,
    statusMessage,
    runShareAction,
  } = useShareAction({
    label,
    onShared,
    onAction: () =>
      shareCreatorProfile({
        username,
        displayName,
        sourceSurface,
        accessToken,
      }),
  });

  return (
    <>
      <button
        type="button"
        onClick={() => void runShareAction()}
        disabled={isLoading}
        aria-busy={isLoading}
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
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {statusMessage}
      </span>
    </>
  );
}
