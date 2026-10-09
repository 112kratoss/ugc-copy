import { Ban, EyeOff, Flag, ShieldAlert, UserRoundX } from 'lucide-react-native';
import { useState } from 'react';
import { Modal, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SheetActionGroup, SheetActionRow } from '@/components/sheet-action-group';
import { SheetBackdrop, SheetGrabber, SheetPanel, sheetPanelStyle, useSheetDismissDrag } from '@/components/sheet-chrome';
import { useReducedMotion } from '@/lib/motion';
import { resolvedBottomInset } from '@/lib/safe-area';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/**
 * The rows of a feed card's ⋮ as a sheet, where the menu cannot be drawn
 * (`lib/feed-feedback-menu.ts` lists the same rows and says why your own post
 * has no creator rows).
 */
export function FeedFeedbackSheet({
  creatorLabel,
  canHideCreator = true,
  onClose,
  onHideCreator,
  onNotInterested,
  onBlockUser,
  onReportContent,
  onReportUser,
  postTitle,
  sessionOnly = false,
  visible,
}: {
  creatorLabel: string;
  /** False on the viewer's own post: the Hide, Report user and Block user rows are left out. */
  canHideCreator?: boolean;
  onClose: () => void;
  onHideCreator: () => void;
  onNotInterested: () => void;
  onBlockUser?: () => void;
  onReportContent?: () => void;
  onReportUser?: () => void;
  postTitle: string;
  sessionOnly?: boolean;
  visible: boolean;
}) {
  const theme = useAppTheme();
  const reducedMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const bottomInset = resolvedBottomInset(insets.bottom);
  const drag = useSheetDismissDrag({ onDismiss: onClose, visible });
  // The screen clears its post as the sheet starts to leave, and a cleared post
  // has no creator. The rows stay as they were while the sheet slides away.
  const [showsCreatorRows, setShowsCreatorRows] = useState(canHideCreator);
  if (visible && showsCreatorRows !== canHideCreator) setShowsCreatorRows(canHideCreator);
  const reportUser = showsCreatorRows ? onReportUser : undefined;
  const blockUser = showsCreatorRows ? onBlockUser : undefined;
  const hasSafetyActions = Boolean(onReportContent || reportUser || blockUser);

  return (
    <Modal
      animationType={reducedMotion ? 'none' : 'slide'}
      accessibilityViewIsModal
      onRequestClose={onClose}
      transparent
      visible={visible}
    >
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <SheetBackdrop drag={drag} label="Close feed preferences" onPress={onClose} />
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
                Shape your feed
              </Text>
              <Text numberOfLines={2} style={{ color: theme.colors.muted, ...appTheme.type.bodySm }}>
                Choose how you want to manage “{postTitle}” or its creator.
              </Text>
            </View>
            <SheetActionGroup>
              <SheetActionRow
                body={sessionOnly
                  ? 'Remove this post from your feed for this visit.'
                  : 'Remove this post and show fewer recommendations like it.'}
                icon={EyeOff}
                label="Not interested"
                onPress={onNotInterested}
              />
              {showsCreatorRows ? (
                <SheetActionRow
                  body={sessionOnly
                    ? `Remove posts from ${creatorLabel} for this visit.`
                    : `Remove posts from ${creatorLabel} from your recommendations.`}
                  icon={UserRoundX}
                  label={`Hide ${creatorLabel}`}
                  onPress={onHideCreator}
                />
              ) : null}
            </SheetActionGroup>
            {hasSafetyActions ? (
              <>
                <Text
                  accessibilityRole="header"
                  style={{
                    color: theme.colors.faint,
                    ...appTheme.type.caption,
                    fontWeight: '800',
                    letterSpacing: 0.8,
                    paddingTop: appTheme.spacing.compact,
                    paddingHorizontal: 4,
                    textTransform: 'uppercase',
                  }}
                >
                  Safety
                </Text>
                <SheetActionGroup>
                  {onReportContent ? (
                    <SheetActionRow
                      body="Send this post to the moderation team for review."
                      icon={Flag}
                      label="Report content"
                      onPress={onReportContent}
                      tone="danger"
                    />
                  ) : null}
                  {reportUser ? (
                    <SheetActionRow
                      body={`Report ${creatorLabel} for unsafe or abusive behavior.`}
                      icon={ShieldAlert}
                      label="Report user"
                      onPress={reportUser}
                      tone="danger"
                    />
                  ) : null}
                  {blockUser ? (
                    <SheetActionRow
                      body={`Hide ${creatorLabel}'s content and prevent future follows between you.`}
                      icon={Ban}
                      label="Block user"
                      onPress={blockUser}
                      tone="danger"
                    />
                  ) : null}
                </SheetActionGroup>
              </>
            ) : null}
          </ScrollView>
        </SheetPanel>
      </View>
    </Modal>
  );
}
