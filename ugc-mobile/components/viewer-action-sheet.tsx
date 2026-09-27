import {
  Archive,
  ArchiveRestore,
  Ban,
  Bookmark,
  BookmarkMinus,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FilePlus2,
  Flag,
  Info,
  LockKeyhole,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  ShieldAlert,
  SlidersHorizontal,
  Trash2,
  UserRoundX,
  Wand2,
  type LucideIcon,
} from 'lucide-react-native';
import { Modal, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SheetActionGroup, SheetActionRow } from '@/components/sheet-action-group';
import { SheetBackdrop, SheetGrabber, SheetPanel, sheetPanelStyle, useSheetDismissDrag } from '@/components/sheet-chrome';
import type { ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';
import { useReducedMotion } from '@/lib/motion';
import { ShareGlyph } from '@/lib/platform-glyphs';
import { resolvedBottomInset } from '@/lib/safe-area';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import { useViewerActionHandlers } from '@/lib/use-viewer-action-handlers';
import { getViewerActionGroupLabel, getViewerActionLabel, isDestructiveViewerAction } from '@/lib/viewer-actions';

export function ViewerActionSheet({
  item,
  onClose,
  onComments,
  onDetails,
  onHideCreator,
  onNotInterested,
  onRecreate,
  onShare,
  onDeleted,
  onBlocked,
  onUnlockRemix,
  onSourceRefresh,
  visible,
}: {
  item: ImmersivePreviewItem;
  onClose: () => void;
  onComments?: () => void;
  onDetails: () => void;
  onHideCreator?: () => void;
  onNotInterested?: () => void;
  onRecreate: () => void;
  onShare: () => void;
  onDeleted?: (postId: string) => void;
  onBlocked?: (userId: string) => void;
  onUnlockRemix?: () => void;
  onSourceRefresh: () => void;
  visible: boolean;
}) {
  const theme = useAppTheme();
  const reducedMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const bottomInset = resolvedBottomInset(insets.bottom);
  const drag = useSheetDismissDrag({ onDismiss: onClose, visible });
  const { actions, handleAction } = useViewerActionHandlers({
    item,
    onClose,
    onComments,
    onDetails,
    onHideCreator,
    onNotInterested,
    onRecreate,
    onShare,
    onDeleted,
    onBlocked,
    onUnlockRemix,
    onSourceRefresh,
  });

  return (
    <Modal animationType={reducedMotion ? 'none' : 'slide'} onRequestClose={onClose} transparent visible={visible}>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <SheetBackdrop drag={drag} label="Close media actions" onPress={onClose} />
        <SheetPanel
          {...drag.contentPanHandlers}
          style={[
            sheetPanelStyle(theme.colors),
            { maxHeight: '84%', paddingBottom: Math.max(bottomInset, appTheme.spacing.panel) },
            drag.dragStyle,
          ]}
        >
          <SheetGrabber drag={drag} />
          <ScrollView
            {...drag.scrollProps}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: appTheme.spacing.panel, gap: appTheme.spacing.gap }}
          >
            <View style={{ gap: 4, paddingBottom: 4 }}>
              <Text accessibilityRole="header" numberOfLines={1} style={{ color: theme.colors.text, ...appTheme.type.cardTitle }}>
                More options
              </Text>
              <Text numberOfLines={2} style={{ color: theme.colors.muted, ...appTheme.type.bodySm }}>
                {item.sourceType === 'showcase'
                  ? `Choose what you want to do with “${item.title}” or ${item.creatorLabel}.`
                  : `Choose what you want to do with “${item.title}”.`}
              </Text>
            </View>
            {groupViewerActions(Array.from(new Set(actions))).map((group) => (
              <View key={group.label} style={{ gap: 4 }}>
                <Text
                  accessibilityRole="header"
                  style={{
                    color: theme.colors.faint,
                    ...appTheme.type.caption,
                    textTransform: 'uppercase',
                    fontWeight: '800',
                    letterSpacing: 0.8,
                    paddingHorizontal: 4,
                    paddingTop: appTheme.spacing.compact,
                  }}
                >
                  {group.label}
                </Text>
                <SheetActionGroup testID={`viewer-action-group-${group.label}`}>
                  {group.actions.map((action) => {
                    const disabledReason = item.disabledActions[action];
                    return (
                      <SheetActionRow
                        key={action}
                        body={disabledReason ?? getViewerActionDescription(action, item)}
                        disabled={Boolean(disabledReason)}
                        icon={getViewerActionIcon(action)}
                        label={getViewerActionLabel(action, item.sourceType)}
                        onPress={() => handleAction(action)}
                        tone={isDestructiveViewerAction(action) ? 'danger' : 'default'}
                      />
                    );
                  })}
                </SheetActionGroup>
              </View>
            ))}
          </ScrollView>
        </SheetPanel>
      </View>
    </Modal>
  );
}

const VIEWER_ACTION_ICONS: Record<string, LucideIcon> = {
  save: Bookmark,
  unsave: BookmarkMinus,
  comment: MessageCircle,
  share: ShareGlyph,
  recreate: Wand2,
  'unlock-remix': LockKeyhole,
  publish: FilePlus2,
  archive: Archive,
  restore: ArchiveRestore,
  'delete-post': Trash2,
  'edit-post': Pencil,
  'change-visibility': Eye,
  'view-linked': ExternalLink,
  'edit-linked': Pencil,
  'edit-linked-resources': SlidersHorizontal,
  'change-linked-visibility': Eye,
  'open-original': ExternalLink,
  'view-details': Info,
  download: Download,
  'not-interested': EyeOff,
  'hide-creator': UserRoundX,
  'report-content': Flag,
  'report-user': ShieldAlert,
  'block-user': Ban,
  'report-ai-output': ShieldAlert,
};

function getViewerActionIcon(action: string) {
  return VIEWER_ACTION_ICONS[action] ?? MoreHorizontal;
}

function getViewerActionDescription(action: string, item: ImmersivePreviewItem) {
  switch (action) {
    case 'save':
      return 'Keep this post in your saved collection.';
    case 'unsave':
      return 'Remove this post from your saved collection.';
    case 'comment':
      return 'Open the conversation on this post.';
    case 'share':
      return 'Send this post or copy its link.';
    case 'recreate':
      return item.sourceType === 'showcase'
        ? 'Use this post as a starting point for your own creation.'
        : 'Create another result from the same setup.';
    case 'unlock-remix':
      return 'Unlock the creator’s recipe and make your own version.';
    case 'publish':
      return 'Turn this creation into a post for your profile.';
    case 'archive':
      return 'Move this item out of your active library.';
    case 'restore':
      return 'Return this item to your active library.';
    case 'delete-post':
      return 'Permanently remove this post and its media.';
    case 'edit-post':
      return 'Change the caption, media, or post settings.';
    case 'change-visibility':
    case 'change-linked-visibility':
      return 'Choose who can see this post.';
    case 'view-linked':
      return 'Open the post created from this media.';
    case 'edit-linked':
      return 'Edit the post created from this media.';
    case 'edit-linked-resources':
      return 'Choose what people receive when they unlock this post.';
    case 'open-original':
      return 'Open this media in its original post.';
    case 'view-details':
      return 'See the prompt, model, and creation information.';
    case 'download':
      return 'Open the original media file.';
    case 'not-interested':
      return 'Remove this post and show fewer recommendations like it.';
    case 'hide-creator':
      return `Remove posts from ${item.creatorLabel} from your recommendations.`;
    case 'report-content':
      return 'Send this post to the moderation team for review.';
    case 'report-user':
      return `Report ${item.creatorLabel} for unsafe or abusive behavior.`;
    case 'block-user':
      return `Hide ${item.creatorLabel}’s content and prevent future follows between you.`;
    case 'report-ai-output':
      return 'Send this generated result to the safety team for review.';
    default:
      return 'Choose this action for the current media.';
  }
}

function groupViewerActions(actions: string[]) {
  const groups: Array<{ label: string; actions: string[] }> = [];

  for (const action of actions) {
    const label = getViewerActionGroupLabel(action);
    const existing = groups.find((group) => group.label === label);
    if (existing) {
      existing.actions.push(action);
    } else {
      groups.push({ label, actions: [action] });
    }
  }

  return groups;
}
