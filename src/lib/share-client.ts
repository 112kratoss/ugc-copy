import {
  buildShowcaseDetailPath,
  buildShowcaseDetailUrl,
  SHARE_SOURCE_QUERY_PARAM,
  type GenerationShareChannel,
  type GenerationShareSourceSurface,
  type ProfileShareSourceSurface,
} from '@/lib/share';
import { buildCreatorProfileUrl } from '@/lib/profile';
import { logBackendError } from '@/lib/backend-logger';
import { currentInviteShareCode } from '@/lib/invite-share-code';
import { withInviteShareCode } from '../../ugc-mobile/lib/invite-share-link/invite-share-link';

/**
 * A link as it leaves the product: with the sharer's invite on it when the
 * account signed in here has one (`?r=<code>`, `invite-share-code.ts`), so a
 * visitor it brings who then signs up counts as that account's referral. Read
 * at the moment of the share, never awaited: a share must go out in the click
 * that asked for it.
 */
export function withSharersInvite(url: string): string {
  return withInviteShareCode(url, currentInviteShareCode());
}

async function postShareClick({
  generationId,
  sourceSurface,
  channel,
  accessToken,
}: {
  generationId: string;
  sourceSurface: GenerationShareSourceSurface;
  channel: GenerationShareChannel;
  accessToken?: string | null;
}) {
  try {
    await fetch('/api/showcase/share', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken
          ? {
              Authorization: `Bearer ${accessToken}`,
            }
          : {}),
      },
      body: JSON.stringify({
        generationId,
        sourceSurface,
        channel,
      }),
    });
  } catch (error) {
    logBackendError('failed_to_record_share_click', { error: error });
  }
}

async function postProfileShareClick({
  username,
  sourceSurface,
  channel,
  accessToken,
}: {
  username: string;
  sourceSurface: ProfileShareSourceSurface;
  channel: GenerationShareChannel;
  accessToken?: string | null;
}) {
  try {
    await fetch('/api/profile/share', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken
          ? {
              Authorization: `Bearer ${accessToken}`,
            }
          : {}),
      },
      body: JSON.stringify({
        username,
        sourceSurface,
        channel,
      }),
    });
  } catch (error) {
    logBackendError('failed_to_record_profile_share_click', { error: error });
  }
}

export async function sharePublicGeneration({
  generationId,
  title,
  description,
  sourceSurface,
  accessToken,
  viewerIsOwner = false,
}: {
  generationId: string;
  title: string;
  description?: string | null;
  sourceSurface: GenerationShareSourceSurface;
  accessToken?: string | null;
  /** Only the creator's own share may claim the work ("Look what I created"). */
  viewerIsOwner?: boolean;
}): Promise<GenerationShareChannel | null> {
  if (typeof window === 'undefined') {
    return null;
  }

  const url = withSharersInvite(buildShowcaseDetailUrl(generationId, window.location.origin, sourceSurface));
  const normalizedTitle = title.trim();
  const normalizedDescription = description?.trim() || null;
  const shareText =
    normalizedTitle
      ? viewerIsOwner
        ? `Look what I created on Magic Booklet: ${normalizedTitle}`
        : `See "${normalizedTitle}" on Magic Booklet`
      : normalizedDescription && normalizedDescription.length <= 80
        ? normalizedDescription
        : viewerIsOwner
          ? `Look what I created on Magic Booklet: ${buildShowcaseDetailPath(generationId)}`
          : `See this creation on Magic Booklet: ${buildShowcaseDetailPath(generationId)}`;

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({
        title: normalizedTitle || 'Magic Booklet creation',
        text: shareText,
        url,
      });
      await postShareClick({
        generationId,
        sourceSurface,
        channel: 'native-share',
        accessToken,
      });
      return 'native-share';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return null;
      }
    }
  }

  if (!navigator.clipboard?.writeText) {
    throw new Error('Clipboard sharing is not supported in this browser');
  }

  await navigator.clipboard.writeText(url);
  await postShareClick({
    generationId,
    sourceSurface,
    channel: 'copy-link',
    accessToken,
  });
  return 'copy-link';
}

export async function shareCreatorProfile({
  username,
  displayName,
  sourceSurface,
  accessToken,
}: {
  username: string;
  displayName: string;
  sourceSurface: ProfileShareSourceSurface;
  accessToken?: string | null;
}): Promise<GenerationShareChannel | null> {
  if (typeof window === 'undefined') {
    return null;
  }

  // The link carries `?s=<surface>`, as a post's does, so the creator page can
  // tell a share visit from a bookmark and credit the surface it came from:
  // `profile` from your own profile, `creator-profile` from a creator's page.
  const shareUrl = new URL(buildCreatorProfileUrl(username, window.location.origin));
  shareUrl.searchParams.set(SHARE_SOURCE_QUERY_PARAM, sourceSurface);
  const url = withSharersInvite(shareUrl.toString());
  const normalizedDisplayName = displayName.trim() || username.trim();
  const normalizedUsername = username.trim().replace(/^@+/, '').toLowerCase();
  const title = `${normalizedDisplayName} on Magic Booklet`;
  const text = normalizedUsername
    ? `Browse ${normalizedDisplayName}'s creator profile on Magic Booklet.`
    : 'Browse this creator profile on Magic Booklet.';

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({
        title,
        text,
        url,
      });
      await postProfileShareClick({
        username,
        sourceSurface,
        channel: 'native-share',
        accessToken,
      });
      return 'native-share';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return null;
      }
    }
  }

  if (!navigator.clipboard?.writeText) {
    throw new Error('Clipboard sharing is not supported in this browser');
  }

  await navigator.clipboard.writeText(url);
  await postProfileShareClick({
    username,
    sourceSurface,
    channel: 'copy-link',
    accessToken,
  });
  return 'copy-link';
}
