/**
 * A post's view count as both clients draw it (post view counts, steps 2 and
 * 3; plan: docs/plans/post-view-counts-2026-11-23.md). The owner's decisions
 * of 2026-11-23: everyone sees a post's views, on the post page and the reel
 * next to saves and comments, on profile grid tiles, in a Home card's action
 * row and as a Views total in the creator page's header.
 *
 * The server counts a view once per person per post per UTC day, while the
 * post is public, never its creator's own (migration 20261123070740), and
 * every post read carries the lifetime total as `viewCount`. This module says
 * what a client draws for it:
 *
 * - nothing (null) for 0, and for a post that is not public: no number at
 *   all, not even to its creator, and never "0 views";
 * - the compact figure: 1 to 999 as they are, then 1.2K, 12K, 1.2M. The figure
 *   is rounded before its unit is picked, so 999,950 reads 1M, never "1000K";
 * - the visible label ("1 view", "1.2K views");
 * - the spoken label, the whole number ("1,234 views").
 *
 * A count is information, never an action: each client draws Lucide's `Eye`
 * with the compact figure and gives a screen reader the spoken label.
 *
 * It is shared with the web by relative import, like the remix credit and the
 * generation setup line: keep it free of React Native, Expo and Node imports.
 * The folder keeps its own self-contained tsconfig.json. It formats by hand
 * rather than with `Intl.NumberFormat`'s compact notation, which Hermes does
 * not promise, so the server's HTML, the browser and the app draw one figure.
 */

/** What a client draws for a count: null where it draws nothing. */
export interface ViewCountLabels {
  /** The count itself, a whole number of 1 or more. */
  count: number;
  /** "1.2K": what is drawn beside the eye. */
  compact: string;
  /** "1.2K views": the figure with its word, where words fit. */
  visible: string;
  /** "1,234 views": the whole number, for a screen reader and a tooltip. */
  spoken: string;
}

/** A post as a read carries it: its total and whether it is public. */
export interface ViewCountPost {
  /** Lifetime views. Left out by a legacy read, which draws nothing. */
  viewCount?: number | null;
  /**
   * Only a public post shows a count. A read that returns public posts alone
   * (the feed, a creator's page) may leave it out, and that reads as public;
   * any other value, null included, shows nothing: a post made private keeps
   * its total for the day it is public again, and nobody sees it meanwhile.
   */
  visibility?: string | null;
  /** A post taken down shows none, whatever its visibility says. */
  archived?: boolean;
}

/** The creator page header's word for the total of a creator's views. */
export const VIEW_COUNT_TOTAL_LABEL = 'Views';

const COMPACT_UNITS = [
  { size: 1_000, suffix: 'K' },
  { size: 1_000_000, suffix: 'M' },
  { size: 1_000_000_000, suffix: 'B' },
] as const;

/** A count's whole number, or 0 for anything that is not a count. */
function wholeCount(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** "12" tenths as "1.2", "10" as "1". */
function formatTenths(tenths: number): string {
  const whole = Math.floor(tenths / 10);
  const tenth = tenths % 10;
  return tenth === 0 ? String(whole) : `${whole}.${tenth}`;
}

/**
 * The compact figure: 1 to 999 as they are, then one decimal below 10 of a
 * unit (1.2K, 9.9K) and none from 10 (12K, 999K), then the same in millions
 * and billions. Each step rounds half up before the unit is picked, and a
 * figure that rounds to 1,000 of its unit moves to the next: 9,950 reads 10K,
 * 999,500 reads 1M. The divisions are by powers of ten, so a half is exact.
 */
export function formatCompactViewCount(value: number | null | undefined): string {
  const count = wholeCount(value);
  if (count < 1_000) return String(count);
  for (let index = 0; index < COMPACT_UNITS.length; index += 1) {
    const { size, suffix } = COMPACT_UNITS[index];
    const tenths = Math.round(count / (size / 10));
    if (tenths < 100) return `${formatTenths(tenths)}${suffix}`;
    const whole = Math.round(count / size);
    if (whole < 1_000 || index === COMPACT_UNITS.length - 1) return `${whole}${suffix}`;
  }
  // Unreachable: the last unit always answers.
  return String(count);
}

/** "1234567" as "1,234,567", the same on every engine. */
function groupThousands(count: number): string {
  const digits = String(count);
  let grouped = '';
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) grouped += ',';
    grouped += digits[index];
  }
  return grouped;
}

function viewWord(count: number): string {
  return count === 1 ? 'view' : 'views';
}

/** The labels of a count, or null at 0 (and for anything that is not a count). */
export function viewCountLabels(value: number | null | undefined): ViewCountLabels | null {
  const count = wholeCount(value);
  if (count === 0) return null;
  const compact = formatCompactViewCount(count);
  return {
    count,
    compact,
    visible: `${compact} ${viewWord(count)}`,
    spoken: `${groupThousands(count)} ${viewWord(count)}`,
  };
}

/** Whether a post may show its views: public, and not taken down. */
export function isViewCountShown(post: Pick<ViewCountPost, 'visibility' | 'archived'>): boolean {
  if (post.archived) return false;
  return post.visibility === undefined || post.visibility === 'public';
}

/** What a post draws for its views: null at 0 and for a post that is not public. */
export function postViewCountLabels(post: ViewCountPost): ViewCountLabels | null {
  return isViewCountShown(post) ? viewCountLabels(post.viewCount) : null;
}
