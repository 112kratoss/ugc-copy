/**
 * Up to two initials for a display name, the first character of each of its
 * first two words. A character, not a UTF-16 unit: half of an emoji's
 * surrogate pair reached the browser as U+FFFD from the server and as itself
 * from the client, so a server-drawn avatar failed hydration. Kept apart from
 * `@/lib/profile` so a first-paint shell can draw initials without its imports.
 */
export function getUserInitials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => Array.from(part)[0]?.toUpperCase() ?? '')
      .join('') || 'U'
  );
}
