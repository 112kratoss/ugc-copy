import Link from 'next/link';
import { Repeat2 } from 'lucide-react';
import clsx from 'clsx';

import {
  remixCreditLabel,
  remixCreditSegments,
  type RemixCredit,
} from '../../../ugc-mobile/lib/remix-credit/remix-credit';

/**
 * A remix post's credit (owner, 2026-11-05): "Remix of “title” by @A", and
 * "· Original by @A" when its chain began with someone else. The title opens
 * the post remixed and each handle its creator's page. Its words and what it
 * leaves out are the shared rule's (`ugc-mobile/lib/remix-credit`); this only
 * draws the segments it is given. Nothing for a post that is no remix.
 *
 * `compact` is a card's: at most two lines, so a chain's "Original by" is not
 * the part cut off (the app's cards do the same); the post page and the reel
 * let it wrap freely.
 */
export default function RemixCreditLine({
  credit,
  compact = false,
  className,
}: {
  credit: RemixCredit | null | undefined;
  compact?: boolean;
  className?: string;
}) {
  if (!credit) return null;
  const segments = remixCreditSegments(credit);

  return (
    <p
      data-testid="remix-credit"
      title={compact ? remixCreditLabel(credit) : undefined}
      className={clsx(
        'flex min-w-0 items-start gap-1.5 text-zinc-400',
        compact ? 'text-[11px] leading-4' : 'text-xs leading-5',
        className,
      )}
    >
      <Repeat2 className={clsx('shrink-0 text-zinc-500', compact ? 'mt-px h-3.5 w-3.5' : 'mt-0.5 h-3.5 w-3.5')} aria-hidden="true" />
      <span className={clsx('min-w-0', compact && 'line-clamp-2')}>
        {segments.map((segment, index) => {
          if (segment.kind === 'post') {
            return (
              <Link
                key={index}
                href={`/showcase/${encodeURIComponent(segment.postId)}`}
                prefetch={false}
                className="ui-focus-ring rounded-lg font-semibold text-zinc-200 transition hover:text-white"
              >
                {segment.text}
              </Link>
            );
          }
          if (segment.kind === 'creator') {
            return (
              <Link
                key={index}
                href={`/creators/${encodeURIComponent(segment.username)}`}
                prefetch={false}
                className="ui-focus-ring rounded-lg font-semibold text-zinc-200 transition hover:text-white"
              >
                {segment.text}
              </Link>
            );
          }
          return <span key={index}>{segment.text}</span>;
        })}
      </span>
    </p>
  );
}
