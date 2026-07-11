import { Modal, Pressable, Text, View } from 'react-native';

import { useReducedMotion } from '@/lib/motion';
import { appTheme } from '@/lib/theme';

export function FeedFeedbackSheet({
  creatorLabel,
  hideCreatorDisabled = false,
  onClose,
  onHideCreator,
  onNotInterested,
  postTitle,
  sessionOnly = false,
  visible,
}: {
  creatorLabel: string;
  hideCreatorDisabled?: boolean;
  onClose: () => void;
  onHideCreator: () => void;
  onNotInterested: () => void;
  postTitle: string;
  sessionOnly?: boolean;
  visible: boolean;
}) {
  const reducedMotion = useReducedMotion();

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
          accessibilityLabel="Close feed controls"
          onPress={onClose}
          style={{ position: 'absolute', inset: 0 }}
        />
        <View
          style={{
            borderTopLeftRadius: appTheme.radii.xl,
            borderTopRightRadius: appTheme.radii.xl,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderBottomWidth: 0,
            borderColor: appTheme.colors.borderStrong,
            backgroundColor: appTheme.colors.panel,
            paddingTop: appTheme.spacing.gap,
            paddingBottom: 34,
          }}
        >
          <View
            style={{
              width: 42,
              height: 4,
              borderRadius: 2,
              backgroundColor: appTheme.colors.borderStrong,
              alignSelf: 'center',
              marginBottom: appTheme.spacing.panel,
            }}
          />
          <View style={{ gap: 5, paddingHorizontal: appTheme.spacing.panel, paddingBottom: appTheme.spacing.gap }}>
            <Text accessibilityRole="header" numberOfLines={1} style={{ color: appTheme.colors.text, ...appTheme.type.cardTitle }}>
              Tune your feed
            </Text>
            <Text numberOfLines={2} style={{ color: appTheme.colors.muted, ...appTheme.type.bodySm }}>
              Choose what you want to see less often. “{postTitle}” will leave this feed now.
            </Text>
          </View>
          <FeedbackAction
            body={sessionOnly
              ? 'Remove this post from the feed for this visit.'
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
        </View>
      </View>
    </Modal>
  );
}

function FeedbackAction({
  body,
  disabled = false,
  label,
  onPress,
}: {
  body: string;
  disabled?: boolean;
  label: string;
  onPress: () => void;
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
      <Text style={{ color: appTheme.colors.text, ...appTheme.type.body, fontWeight: '800' }}>
        {label}
      </Text>
      <Text style={{ color: appTheme.colors.faint, ...appTheme.type.caption }}>
        {body}
      </Text>
    </Pressable>
  );
}
