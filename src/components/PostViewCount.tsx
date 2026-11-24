import { Eye } from 'lucide-react';

import type { ViewCountLabels } from '../../ugc-mobile/lib/view-count/view-count';

/**
 * A post's views as the web draws them (post view counts, step 2): Lucide's
 * `Eye` and the compact figure ("1.2K"), on the post page and the reel next to
 * saves and comments, in a Home card's action row and on profile grid tiles.
 * The labels are the shared rule's (`ugc-mobile/lib/view-count/`), which draws
 * nothing at 0 and nothing for a post that is not public, so a caller with no
 * labels draws no element at all.
 *
 * A count is information, never an action: it is no button and no link, takes
 * no press, has no hover state and no tab stop. A screen reader hears the
 * whole number ("1,234 views"), once; a mouse resting on it is shown the same
 * words, from the hidden figure's `title`, which no screen reader reads.
 */
export default function PostViewCount({
  labels,
  className,
  figureClassName = 'inline-flex items-center gap-2',
  iconClassName = 'h-4 w-4 shrink-0',
}: {
  labels: ViewCountLabels | null;
  /** The count's place in its row or tile. */
  className?: string;
  /** How the eye and the figure sit together: side by side, or stacked in the reel's rail. */
  figureClassName?: string;
  iconClassName?: string;
}) {
  if (!labels) return null;
  return (
    <span className={className} data-post-view-count={labels.count}>
      <span aria-hidden="true" title={labels.spoken} className={figureClassName}>
        <Eye className={iconClassName} aria-hidden="true" />
        <span className="tabular-nums">{labels.compact}</span>
      </span>
      <span className="sr-only">{labels.spoken}</span>
    </span>
  );
}
