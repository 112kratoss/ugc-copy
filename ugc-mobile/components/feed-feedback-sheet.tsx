import { Modal, Pressable, ScrollView, Text, View } from 'react-native';

import { SheetGrabber, SheetPanel, useSheetDismissDrag } from '@/components/sheet-chrome';
import { useReducedMotion } from '@/lib/motion';
import { appTheme } from '@/lib/theme';

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
  const reducedMotion = useReducedMotion();
  const drag = useSheetDismissDrag({ onDismiss: onClose });

  return (
    <Modal
      animationType={reducedMotion ? 'none' : 'slide'}
      accessibilityViewIsModal
      onRequestClose={onClose}
      transparent
      visible={visible}
    >
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.58)' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close Showcase preferences"
          onPress={onClose}
          style={{ position: 'absolute', inset: 0 }}
        />
        <SheetPanel
          style={[
            {
              maxHeight: '84%',
              borderTopLeftRadius: appTheme.radii.xl,
              borderTopRightRadius: appTheme.radii.xl,
              borderCurve: 'continuous',
              borderWidth: 1,
              borderBottomWidth: 0,
              borderColor: appTheme.colors.borderStrong,
              backgroundColor: appTheme.colors.panel,
              paddingBottom: 34,
            },
            drag.dragStyle,
          ]}
        >
          <SheetGrabber drag={drag} />
          <ScrollView showsVerticalScrollIndicator={false}>
            <View style={{ gap: 5, paddingHorizontal: appTheme.spacing.panel, paddingBottom: appTheme.spacing.gap }}>
              <Text accessibilityRole="header" numberOfLines={1} style={{ color: appTheme.colors.text, ...appTheme.type.cardTitle }}>
                Shape your Showcase
              </Text>
              <Text numberOfLines={2} style={{ color: appTheme.colors.muted, ...appTheme.type.bodySm }}>
                Choose how you want to manage “{postTitle}” or its creator.
              </Text>
            </View>
            <FeedbackAction
              body={sessionOnly
                ? 'Remove this post from your Showcase for this visit.'
                : 'Remove this post and show fewer recommendations like it.'}
              label="Not interested"
              onPress={onNotInterested}
            />
            <FeedbackAction
              body={hideCreatorDisabled
                ? 'You cannot hide your own creator profile.'
                : sessionOnly
                  ? `Remove posts from ${creatorLabel} for this visit.`
                  : `Remove posts from ${creatorLabel} from your recommendations.`}
              disabled={hideCreatorDisabled}
              label={`Hide ${creatorLabel}`}
              onPress={onHideCreator}
            />
            {onReportContent || onReportUser || onBlockUser ? (
              <Text
                accessibilityRole="header"
                style={{
                  color: appTheme.colors.faint,
                  ...appTheme.type.caption,
                  fontWeight: '800',
                  letterSpacing: 0.8,
                  paddingHorizontal: appTheme.spacing.panel,
                  paddingTop: appTheme.spacing.gap,
                  textTransform: 'uppercase',
                }}
              >
                Safety
              </Text>
            ) : null}
            {onReportContent ? (
              <FeedbackAction
                body="Send this post to the moderation team for review."
                label="Report content"
                onPress={onReportContent}
                tone="danger"
              />
            ) : null}
            {onReportUser ? (
              <FeedbackAction
                body={`Report ${creatorLabel} for unsafe or abusive behavior.`}
                disabled={hideCreatorDisabled}
                label="Report user"
                onPress={onReportUser}
                tone="danger"
              />
            ) : null}
            {onBlockUser ? (
              <FeedbackAction
                body={`Hide ${creatorLabel}'s content and prevent future follows between you.`}
                disabled={hideCreatorDisabled}
                label="Block user"
                onPress={onBlockUser}
                tone="danger"
              />
            ) : null}
          </ScrollView>
        </SheetPanel>
      </View>
    </Modal>
  );
}

function FeedbackAction({
  body,
  disabled = false,
  label,
  onPress,
  tone = 'default',
}: {
  body: string;
  disabled?: boolean;
  label: string;
  onPress: () => void;
  tone?: 'default' | 'danger';
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={body}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 64,
        justifyContent: 'center',
        gap: 3,
        paddingHorizontal: appTheme.spacing.panel,
        paddingVertical: appTheme.spacing.gap,
        backgroundColor: pressed ? appTheme.colors.surface : 'transparent',
        opacity: disabled ? appTheme.opacity.disabled : 1,
      })}
    >
      <Text style={{ color: tone === 'danger' ? appTheme.colors.danger : appTheme.colors.text, ...appTheme.type.body, fontWeight: '800' }}>
        {label}
      </Text>
      <Text style={{ color: appTheme.colors.faint, ...appTheme.type.caption }}>
        {body}
      </Text>
    </Pressable>
  );
}
