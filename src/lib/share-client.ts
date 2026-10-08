import {
  buildShowcaseDetailPath,
  buildShowcaseDetailUrl,
  type GenerationShareChannel,
  type GenerationShareSourceSurface,
  type ProfileShareSourceSurface,
} from '@/lib/share';
import { buildCreatorProfileUrl } from '@/lib/profile';
import { logBackendError } from '@/lib/backend-logger';

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

  const url = buildShowcaseDetailUrl(generationId, window.location.origin, sourceSurface);
  const normalizedTitle = title.trim();
  const normalizedDescription = description?.trim() || null;
  const shareText =
    normalizedTitle
      ? viewerIsOwner
        ? `Look what I created on magicbooklet: ${normalizedTitle}`
        : `See "${normalizedTitle}" on magicbooklet`
      : normalizedDescription && normalizedDescription.length <= 80
        ? normalizedDescription
        : viewerIsOwner
          ? `Look what I created on magicbooklet: ${buildShowcaseDetailPath(generationId)}`
          : `See this creation on magicbooklet: ${buildShowcaseDetailPath(generationId)}`;

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({
        title: normalizedTitle || 'magicbooklet creation',
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

  const url = buildCreatorProfileUrl(username, window.location.origin);
  const normalizedDisplayName = displayName.trim() || username.trim();
  const normalizedUsername = username.trim().replace(/^@+/, '').toLowerCase();
  const title = `${normalizedDisplayName} on magicbooklet`;
  const text = normalizedUsername
    ? `Browse ${normalizedDisplayName}'s creator profile on magicbooklet.`
    : 'Browse this creator profile on magicbooklet.';

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
