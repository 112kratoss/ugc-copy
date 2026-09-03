/**
 * How a media tool's failure is recorded in a `*_error` column.
 *
 * These messages carry a command-line tool's stderr, and stderr from ffmpeg (or
 * sharp) puts the diagnosis at the *end*: the front is a build banner and a
 * stream dump that is identical on every run, success or failure. A plain
 * `slice(0, limit)` therefore stores the one part of the message that says
 * nothing — a poster that failed with `ffmpeg exited with code 254: <banner>`
 * looked, in the database, like a generic ffmpeg invocation, and the actual
 * `input-video: No such file or directory` never made it out of the process.
 *
 * So keep both ends: enough of the head to name the failure, and as much of the
 * tail as the budget allows.
 */

const DEFAULT_LIMIT = 500;
const HEAD_BUDGET = 140;
const ELISION = '\n…\n';

export function summarizeMediaToolError(error: unknown, fallback: string, limit = DEFAULT_LIMIT): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';

  return truncateMediaToolMessage(message, limit) || fallback;
}

export function truncateMediaToolMessage(message: string, limit = DEFAULT_LIMIT): string {
  const trimmed = message.trim();
  if (trimmed.length <= limit) return trimmed;

  // A limit too small to hold both ends plus the marker keeps the tail, which
  // is the half that carries the diagnosis.
  const tailBudget = limit - HEAD_BUDGET - ELISION.length;
  if (tailBudget <= 0) return trimmed.slice(-limit);

  return `${trimmed.slice(0, HEAD_BUDGET).trimEnd()}${ELISION}${trimmed.slice(-tailBudget).trimStart()}`;
}
