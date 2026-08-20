const FALLBACK_ADMIN_PATH = '/admin';
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const ENCODED_SEPARATOR_PATTERN = /%(?:2f|5c)/i;
const MAX_RECURSIVE_DECODE_DEPTH = 6;

function containsUnsafeRepresentation(value: string): boolean {
  let decoded = value;

  // Decode repeatedly so a second encoding layer cannot hide a slash,
  // backslash, or control byte from the URL parser.
  // Include the post-sixth-decode value in the inspection. If that value still
  // decodes further, reject it: every accepted representation must reach a
  // stable form within this bound.
  for (let depth = 0; depth <= MAX_RECURSIVE_DECODE_DEPTH; depth += 1) {
    if (
      CONTROL_CHARACTER_PATTERN.test(decoded)
      || decoded.includes('\\')
      || ENCODED_SEPARATOR_PATTERN.test(decoded)
    ) {
      return true;
    }

    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return true;
    }
    if (next === decoded) return false;
    decoded = next;
  }

  // More encoding layers than the application could legitimately produce are
  // rejected rather than interpreted differently by a downstream router.
  return true;
}

/**
 * Converts an admin login continuation into a normalized same-origin path.
 * Unsafe inputs always land on the console root.
 */
export function resolveSafeAdminRedirect(
  value: string | null,
  currentOrigin: string,
): string {
  if (
    !value
    || value !== value.trim()
    || !value.startsWith('/')
    || containsUnsafeRepresentation(value)
  ) {
    return FALLBACK_ADMIN_PATH;
  }

  try {
    const origin = new URL(currentOrigin).origin;
    const destination = new URL(value, origin);
    if (
      destination.origin !== origin
      || destination.username
      || destination.password
      || (destination.pathname !== '/admin' && !destination.pathname.startsWith('/admin/'))
    ) {
      return FALLBACK_ADMIN_PATH;
    }

    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return FALLBACK_ADMIN_PATH;
  }
}
