import { Ban, EyeOff, Flag, ShieldAlert, UserRoundX, type LucideIcon } from 'lucide-react-native';
import { Children, Fragment } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SheetBackdrop, SheetGrabber, SheetPanel, sheetPanelStyle, useSheetDismissDrag } from '@/components/sheet-chrome';
import { useReducedMotion } from '@/lib/motion';
import { resolvedBottomInset } from '@/lib/safe-area';
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
        <SheetBackdrop drag={drag} label="Close Showcase preferences" onPress={onClose} />
        <SheetPanel
          {...drag.contentPanHandlers}
          style={[
            sheetPanelStyle(),
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
              <Text accessibilityRole="header" numberOfLines={1} style={{ color: appTheme.colors.text, ...appTheme.type.cardTitle }}>
                Shape your Showcase
              </Text>
              <Text numberOfLines={2} style={{ color: appTheme.colors.muted, ...appTheme.type.bodySm }}>
                Choose how you want to manage “{postTitle}” or its creator.
              </Text>
            </View>
            <ActionGroup>
              <FeedbackAction
                body={sessionOnly
                  ? 'Remove this post from your Showcase for this visit.'
                  : 'Remove this post and show fewer recommendations like it.'}
                icon={EyeOff}
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
                icon={UserRoundX}
                label={`Hide ${creatorLabel}`}
                onPress={onHideCreator}
              />
            </ActionGroup>
            {hasSafetyActions ? (
              <>
                <Text
                  accessibilityRole="header"
                  style={{
                    color: appTheme.colors.faint,
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
                <ActionGroup>
                  {onReportContent ? (
                    <FeedbackAction
                      body="Send this post to the moderation team for review."
                      icon={Flag}
                      label="Report content"
                      onPress={onReportContent}
                      tone="danger"
                    />
                  ) : null}
                  {onReportUser ? (
                    <FeedbackAction
                      body={`Report ${creatorLabel} for unsafe or abusive behavior.`}
                      disabled={hideCreatorDisabled}
                      icon={ShieldAlert}
                      label="Report user"
                      onPress={onReportUser}
                      tone="danger"
                    />
                  ) : null}
                  {onBlockUser ? (
                    <FeedbackAction
                      body={`Hide ${creatorLabel}'s content and prevent future follows between you.`}
                      disabled={hideCreatorDisabled}
                      icon={Ban}
                      label="Block user"
                      onPress={onBlockUser}
                      tone="danger"
                    />
                  ) : null}
                </ActionGroup>
              </>
            ) : null}
          </ScrollView>
        </SheetPanel>
      </View>
    </Modal>
  );
}

// The icon well and the gap after it: the row dividers start where the text
// does, the way a grouped list keeps its hairlines out of the icon column.
const ACTION_ICON_WELL = 40;
const ACTION_ICON_GAP = 14;

/**
 * Rows in one rounded group, divided by hairlines that begin at the text.
 *
 * Grouping is what makes a list of choices read as choices rather than as
 * paragraphs: the earlier version drew each action as bare bold text over a
 * caption, which is the shape of an article, not a menu.
 */
function ActionGroup({ children }: { children: React.ReactNode }) {
  const rows = Children.toArray(children);

  return (
    <View
      style={{
        borderRadius: appTheme.radii.lg,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: appTheme.colors.borderSubtle,
        backgroundColor: appTheme.colors.panelSoft,
        overflow: 'hidden',
      }}
    >
      {rows.map((row, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <View
              style={{
                height: 1,
                marginLeft: appTheme.spacing.card + ACTION_ICON_WELL + ACTION_ICON_GAP,
                backgroundColor: appTheme.colors.border,
              }}
            />
          ) : null}
          {row}
        </Fragment>
      ))}
    </View>
  );
}

function FeedbackAction({
  body,
  disabled = false,
  icon: Icon,
  label,
  onPress,
  tone = 'default',
}: {
  body: string;
  disabled?: boolean;
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  tone?: 'default' | 'danger';
}) {
  const danger = tone === 'danger';

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
        flexDirection: 'row',
        alignItems: 'center',
        gap: ACTION_ICON_GAP,
        paddingHorizontal: appTheme.spacing.card,
        paddingVertical: appTheme.spacing.gap,
        backgroundColor: pressed ? appTheme.colors.surfaceStrong : 'transparent',
        opacity: disabled ? appTheme.opacity.disabled : 1,
      })}
    >
      <View
        style={{
          width: ACTION_ICON_WELL,
          height: ACTION_ICON_WELL,
          borderRadius: ACTION_ICON_WELL / 2,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: danger ? appTheme.semantic.danger.background : appTheme.colors.surfaceStrong,
        }}
      >
        <Icon size={appTheme.icon.default} color={danger ? appTheme.colors.danger : appTheme.colors.textSecondary} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={{ color: danger ? appTheme.colors.danger : appTheme.colors.text, ...appTheme.type.body, fontWeight: '700' }}>
          {label}
        </Text>
        <Text style={{ color: appTheme.colors.muted, ...appTheme.type.caption }}>
          {body}
        </Text>
      </View>
    </Pressable>
  );
}
