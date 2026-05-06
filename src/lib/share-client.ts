import {
  buildShowcaseDetailPath,
  buildShowcaseDetailUrl,
  type GenerationShareChannel,
  type GenerationShareSourceSurface,
} from '@/lib/share';
import { buildCreatorProfileUrl } from '@/lib/profile';

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
    console.error('Failed to record share click:', error);
  }
}

export async function sharePublicGeneration({
  generationId,
  title,
  description,
  sourceSurface,
  accessToken,
}: {
  generationId: string;
  title: string;
  description?: string | null;
  sourceSurface: GenerationShareSourceSurface;
  accessToken?: string | null;
}): Promise<GenerationShareChannel | null> {
  if (typeof window === 'undefined') {
    return null;
  }

  const url = buildShowcaseDetailUrl(generationId, window.location.origin);
  const normalizedTitle = title.trim();
  const normalizedDescription = description?.trim() || null;
  const shareText =
    normalizedTitle
      ? `Look what I created on magicbooklet: ${normalizedTitle}`
      : normalizedDescription && normalizedDescription.length <= 80
        ? normalizedDescription
        : `Look what I created on magicbooklet: ${buildShowcaseDetailPath(generationId)}`;

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
}: {
  username: string;
  displayName: string;
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
  return 'copy-link';
}
