'use client';

import { Check, Loader2, Share2 } from 'lucide-react';

import { ShareLinkSheet } from '@/components/PublicShareButton';
import { SHARE_BUSY_STYLE, useShareAction } from '@/components/useShareAction';
import { shareCreatorProfile } from '@/lib/share-client';
import type { ProfileShareSourceSurface } from '@/lib/share';

interface ProfileShareButtonProps {
  username: string;
  displayName: string;
  sourceSurface: ProfileShareSourceSurface;
  accessToken?: string | null;
  className?: string;
  label?: string;
}

export default function ProfileShareButton({
  username,
  displayName,
  sourceSurface,
  accessToken,
  className,
  label = 'Share profile',
}: ProfileShareButtonProps) {
  const {
    state,
    isLoading,
    resolvedLabel,
    statusMessage,
    runShareAction,
    refusedLink,
    copyRefusedLink,
    countRefusedLinkCopiedByHand,
    dismissRefusedLink,
  } = useShareAction({
    label,
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
        // Busy while it shares, never disabled, so the focus stays on it (`SHARE_BUSY_STYLE`).
        aria-disabled={isLoading || undefined}
        aria-busy={isLoading}
        className={className}
        style={isLoading ? SHARE_BUSY_STYLE : undefined}
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
      {refusedLink ? (
        <ShareLinkSheet
          link={refusedLink}
          onCopy={copyRefusedLink}
          onCopiedByHand={countRefusedLinkCopiedByHand}
          onClose={dismissRefusedLink}
        />
      ) : null}
    </>
  );
}
