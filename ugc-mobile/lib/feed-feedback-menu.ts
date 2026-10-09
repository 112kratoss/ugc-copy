import { hideCreatorLabel } from '@/lib/hide-creator-label';
import { menuAction, type NativeMenuModel } from '@/lib/native-menu';

export interface FeedFeedbackMenuInput {
  /** The post's creator, whom the Hide row names (`lib/hide-creator-label.ts`). */
  creator: { username?: string | null; name?: string | null };
  /**
   * False on the viewer's own post and on one with no creator account: there
   * is no one to hide, report or block, and those rows are left out. The web
   * card's menu calls it the same (`ShowcaseFeedbackMenu`).
   */
  canHideCreator: boolean;
  /**
   * True on the viewer's own post, where Report content is left out as well: it
   * would ask for a review of the viewer's own work. The web card's menu is
   * given no handler for it there (`FeedPostCard`).
   */
  viewerIsOwner: boolean;
  /** A guest's choices last for this visit only; a signed-in viewer's retrain the feed. */
  sessionOnly: boolean;
  onNotInterested: () => void;
  onHideCreator: () => void;
  onReportContent?: () => void;
  onReportUser?: () => void;
  onBlockUser?: () => void;
}

/**
 * Whether a post is its viewer's own. A guest has made none, and a post with
 * no creator account is no one's.
 */
export function isOwnFeedPost(creatorId: string | null | undefined, viewerId: string | null | undefined): boolean {
  return Boolean(viewerId) && creatorId === viewerId;
}

/**
 * Whether a post's creator is someone its viewer can hide, report or block: an
 * account, and not the viewer's own. Home and Explore ask this and
 * `isOwnFeedPost` for the menu and for its sheet, so the two screens cannot
 * answer differently, and the reel's menu asks both for the same rows
 * (`getViewerSafetyActions` in `lib/viewer-actions.ts`).
 */
export function canHideFeedCreator(creatorId: string | null | undefined, viewerId: string | null | undefined): boolean {
  return Boolean(creatorId) && !isOwnFeedPost(creatorId, viewerId);
}

/**
 * The menu a Home or Explore card's ⋮ opens: the rows `FeedFeedbackSheet`
 * carries, as a native menu (`lib/native-menu.ts`).
 *
 * The sheet explained every row in a sentence; a menu row has room for one short
 * line, so only the line that changes what a choice means survives: a guest's
 * choice lasts for the visit.
 *
 * Your own post has no Hide, Report user or Block user row. A dimmed row says
 * "not now"; nothing can ever make these apply to yourself, so they are left
 * out, as the reel's menu (`getViewerSafetyActions` in `lib/viewer-actions.ts`)
 * and the web's leave them out. Until 2026-10-09 a card dimmed them and the
 * reel did not list them.
 *
 * It has no Report content row either: that leaves Not interested as its one
 * row, as on the web's card. The app kept the row until 2026-10-09, and the
 * server took the report it sent.
 */
export function buildFeedFeedbackMenu({
  creator,
  canHideCreator,
  viewerIsOwner,
  sessionOnly,
  onNotInterested,
  onHideCreator,
  onReportContent,
  onReportUser,
  onBlockUser,
}: FeedFeedbackMenuInput): NativeMenuModel {
  const forThisVisit = sessionOnly ? 'For this visit' : undefined;
  return {
    quickActions: [],
    sections: [
      {
        id: 'preferences',
        // iOS draws the guest's note once, as the section's heading; its rows
        // carry no subtitle there (`native-menu.ios.tsx`).
        title: forThisVisit,
        items: [
          menuAction({
            id: 'not-interested',
            label: 'Not interested',
            subtitle: forThisVisit,
            systemImage: 'eye.slash',
            onSelect: onNotInterested,
          }),
          ...(canHideCreator ? [menuAction({
            id: 'hide-creator',
            label: hideCreatorLabel(creator),
            subtitle: forThisVisit,
            systemImage: 'person.crop.circle.badge.xmark',
            onSelect: onHideCreator,
          })] : []),
        ],
      },
      {
        id: 'safety',
        title: 'Safety',
        items: [
          ...(onReportContent && !viewerIsOwner ? [menuAction({
            id: 'report-content',
            label: 'Report content',
            systemImage: 'flag',
            destructive: true,
            onSelect: onReportContent,
          })] : []),
          ...(canHideCreator && onReportUser ? [menuAction({
            id: 'report-user',
            label: 'Report user',
            systemImage: 'exclamationmark.shield',
            destructive: true,
            onSelect: onReportUser,
          })] : []),
          ...(canHideCreator && onBlockUser ? [menuAction({
            id: 'block-user',
            label: 'Block user',
            systemImage: 'nosign',
            destructive: true,
            onSelect: onBlockUser,
          })] : []),
        ],
      },
    ],
  };
}
