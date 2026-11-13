import { menuAction, type NativeMenuModel } from '@/lib/native-menu';

export interface CommentMenuInput {
  /** The viewer wrote the comment. */
  canDelete: boolean;
  /** The comment sits on the viewer's post. */
  canRemove: boolean;
  /** Someone else wrote it. */
  canReport: boolean;
  /**
   * Given when the viewer may block the comment's author from here
   * (`canBlockCommentAuthor`); the row names them.
   */
  block?: { authorLabel: string; onBlock: () => void } | null;
  /** The viewer wrote the comment and may reword it. */
  canEdit?: boolean;
  /**
   * Given when the comment sits on the viewer's post and may hold its pin
   * (`canPinComment`); `pinned` says which way the row reads.
   */
  pin?: { pinned: boolean; onToggle: () => void } | null;
  onEdit?: () => void;
  onDelete: () => void;
  onRemove: () => void;
  onReport: () => void;
}

/**
 * The menu a comment's ••• opens (`lib/native-menu.ts`); a build without native
 * menus shows the same rows as the "Comment options" action sheet. Every row
 * that takes something away still asks before it acts: Delete, Remove and
 * Block through a confirmation, Report through the sheet of reasons that
 * follows it. Pin and Edit, which are undone by pressing again, lead the menu
 * and do not ask.
 */
export function buildCommentMenu({
  canDelete,
  canRemove,
  canReport,
  block,
  canEdit = false,
  pin = null,
  onEdit,
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
          ...(pin ? [menuAction({
            id: 'pin',
            label: pin.pinned ? 'Unpin' : 'Pin',
            systemImage: pin.pinned ? 'pin.slash' : 'pin',
            onSelect: pin.onToggle,
          })] : []),
          ...(canEdit && onEdit ? [menuAction({
            id: 'edit',
            label: 'Edit',
            systemImage: 'pencil',
            onSelect: onEdit,
          })] : []),
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
          ...(block ? [menuAction({
            id: 'block',
            label: `Block ${block.authorLabel}`,
            systemImage: 'nosign',
            destructive: true,
            onSelect: block.onBlock,
          })] : []),
        ],
      },
    ],
  };
}
