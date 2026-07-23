export const POST_MEDIA_KEY_MAX_LENGTH = 80;

const POST_MEDIA_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function normalizePostMediaKey(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > POST_MEDIA_KEY_MAX_LENGTH
    || !POST_MEDIA_KEY_PATTERN.test(normalized)
  ) {
    return null;
  }

  return normalized;
}

export function defaultPostMediaKey(index: number): string {
  return `media-${Math.max(0, Math.round(index)) + 1}`;
}
