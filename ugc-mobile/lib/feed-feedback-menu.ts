import { menuAction, type NativeMenuModel } from '@/lib/native-menu';

export interface FeedFeedbackMenuInput {
  /** How the creator is named on the card: "@name". */
  creatorLabel: string;
  /**
   * The viewer's own post, or one with no creator account: there is no one to
   * hide, report or block.
   */
  hideCreatorDisabled: boolean;
  /** A guest's choices last for this visit only; a signed-in viewer's retrain the feed. */
  sessionOnly: boolean;
  onNotInterested: () => void;
  onHideCreator: () => void;
  onReportContent?: () => void;
  onReportUser?: () => void;
  onBlockUser?: () => void;
}

/**
 * The menu a Home or Explore card's ⋮ opens: the rows `FeedFeedbackSheet`
 * carries, as a native menu (`lib/native-menu.ts`).
 *
 * The sheet explained every row in a sentence; a menu row has room for one short
 * line, so only the line that changes what a choice means survives: a guest's
 * choice lasts for the visit. Rows that cannot apply to your own post stay in
 * the menu, disabled, where the sheet kept them — the Menus chapter keeps an
 * unavailable item visible so people learn where it lives.
 */
export function buildFeedFeedbackMenu({
  creatorLabel,
  hideCreatorDisabled,
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
          menuAction({
            id: 'hide-creator',
            label: `Hide ${creatorLabel}`,
            subtitle: forThisVisit,
            systemImage: 'person.crop.circle.badge.xmark',
            disabled: hideCreatorDisabled,
            onSelect: onHideCreator,
          }),
        ],
      },
      {
        id: 'safety',
        title: 'Safety',
        items: [
          ...(onReportContent ? [menuAction({
            id: 'report-content',
            label: 'Report content',
            systemImage: 'flag',
            destructive: true,
            onSelect: onReportContent,
          })] : []),
          ...(onReportUser ? [menuAction({
            id: 'report-user',
            label: 'Report user',
            systemImage: 'exclamationmark.shield',
            destructive: true,
            disabled: hideCreatorDisabled,
            onSelect: onReportUser,
          })] : []),
          ...(onBlockUser ? [menuAction({
            id: 'block-user',
            label: 'Block user',
            systemImage: 'nosign',
            destructive: true,
            disabled: hideCreatorDisabled,
            onSelect: onBlockUser,
          })] : []),
        ],
      },
    ],
  };
}
