import { Ban, EyeOff, Flag, ShieldAlert, UserRoundX } from 'lucide-react-native';
import { Modal, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SheetActionGroup, SheetActionRow } from '@/components/sheet-action-group';
import { SheetBackdrop, SheetGrabber, SheetPanel, sheetPanelStyle, useSheetDismissDrag } from '@/components/sheet-chrome';
import { useReducedMotion } from '@/lib/motion';
import { resolvedBottomInset } from '@/lib/safe-area';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

export function FeedFeedbackSheet({
  creatorLabel,
  hideCreatorDisabled = false,
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
  hideCreatorDisabled?: boolean;
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
  const hasSafetyActions = Boolean(onReportContent || onReportUser || onBlockUser);

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
              <SheetActionRow
                body={hideCreatorDisabled
                  ? 'You cannot hide your own creator profile.'
                  : sessionOnly
                    ? `Remove posts from ${creatorLabel} for this visit.`
                    : `Remove posts from ${creatorLabel} from your recommendations.`}
                disabled={hideCreatorDisabled}
                icon={UserRoundX}
                label={`Hide ${creatorLabel}`}
                onPress={onHideCreator}
              />
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
                  {onReportUser ? (
                    <SheetActionRow
                      body={`Report ${creatorLabel} for unsafe or abusive behavior.`}
                      disabled={hideCreatorDisabled}
                      icon={ShieldAlert}
                      label="Report user"
                      onPress={onReportUser}
                      tone="danger"
                    />
                  ) : null}
                  {onBlockUser ? (
                    <SheetActionRow
                      body={`Hide ${creatorLabel}'s content and prevent future follows between you.`}
                      disabled={hideCreatorDisabled}
                      icon={Ban}
                      label="Block user"
                      onPress={onBlockUser}
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
