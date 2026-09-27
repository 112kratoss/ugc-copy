import { menuAction, type NativeMenuModel } from '@/lib/native-menu';

export interface CommentMenuInput {
  /** The viewer wrote the comment. */
  canDelete: boolean;
  /** The comment sits on the viewer's post. */
  canRemove: boolean;
  /** Someone else wrote it. */
  canReport: boolean;
  onDelete: () => void;
  onRemove: () => void;
  onReport: () => void;
}

/**
 * The menu a comment's ••• opens (`lib/native-menu.ts`); a build without native
 * menus shows the same rows as the "Comment options" action sheet. Every row
 * still asks before it acts: Delete and Remove through a confirmation, Report
 * through the sheet of reasons that follows it.
 */
export function buildCommentMenu({
  canDelete,
  canRemove,
  canReport,
  onDelete,
  onRemove,
  onReport,
}: CommentMenuInput): NativeMenuModel {
  return {
    quickActions: [],
    sections: [
      {
        id: 'comment',
        items: [
          ...(canDelete ? [menuAction({
            id: 'delete',
            label: 'Delete',
            systemImage: 'trash',
            destructive: true,
            onSelect: onDelete,
          })] : []),
          ...(canRemove ? [menuAction({
            id: 'remove',
            label: 'Remove from post',
            systemImage: 'minus.circle',
            destructive: true,
            onSelect: onRemove,
          })] : []),
          ...(canReport ? [menuAction({
            id: 'report',
            label: 'Report',
            systemImage: 'flag',
            destructive: true,
            onSelect: onReport,
          })] : []),
        ],
      },
    ],
  };
}
