import { Modal, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SheetBackdrop, SheetGrabber, SheetPanel, sheetPanelStyle, useSheetDismissDrag } from '@/components/sheet-chrome';
import { PrimaryButton, SecondaryButton } from '@/components/ui';
import { useReducedMotion } from '@/lib/motion';
import { resolvedBottomInset } from '@/lib/safe-area';
import { appTheme } from '@/lib/theme';

/**
 * The only OTA update the app ever mentions out loud.
 *
 * Routine updates are silent by design — a copy fix should simply be correct
 * the next time the app opens, and announcing it invites people to go looking
 * for a change they would not otherwise notice. This sheet is reserved for an
 * update published with `extra.critical`, meaning something is actively hurting
 * users and waiting for their next cold start is too slow.
 *
 * It cannot appear mid-work: the activity lock vetoes the decision before this
 * ever renders (lib/app-update-policy). So by the time someone sees it they are
 * idle, and "Not now" is a real answer rather than a trap — dismissing stops it
 * asking again this session, and the update lands quietly once they go idle
 * again or next open the app.
 *
 * Shares the app's sheet chrome deliberately. An interruption is the worst
 * possible place to introduce an unfamiliar shape or motion; it should read as
 * the same surface as every other sheet, just with something urgent in it.
 */
export function CriticalUpdateSheet({
  onDismiss,
  onRestart,
  visible,
}: {
  onDismiss: () => void;
  onRestart: () => void;
  visible: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const bottomInset = resolvedBottomInset(insets.bottom);
  const drag = useSheetDismissDrag({ onDismiss, visible });

  return (
    <Modal
      animationType={reducedMotion ? 'none' : 'slide'}
      accessibilityViewIsModal
      onRequestClose={onDismiss}
      transparent
      visible={visible}
    >
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <SheetBackdrop drag={drag} label="Dismiss the update prompt" onPress={onDismiss} />
        <SheetPanel
          {...drag.contentPanHandlers}
          style={[
            sheetPanelStyle(),
            { paddingBottom: Math.max(bottomInset, appTheme.spacing.panel) },
            drag.dragStyle,
          ]}
        >
          <SheetGrabber drag={drag} />
          <View
            style={{
              gap: 5,
              paddingHorizontal: appTheme.spacing.panel,
              paddingBottom: appTheme.spacing.gap,
            }}
          >
            <Text
              accessibilityRole="header"
              style={{ color: appTheme.colors.text, ...appTheme.type.cardTitle }}
            >
              An important fix is ready
            </Text>
            {/* Says what restarting costs, because that is the only thing the
                person actually needs to decide. No version number, no changelog
                — neither helps them answer the question being asked. */}
            <Text style={{ color: appTheme.colors.muted, ...appTheme.type.bodySm }}>
              Restarting takes a moment and you will come back to where you are now.
            </Text>
          </View>
          <View
            style={{
              gap: appTheme.spacing.gap,
              paddingHorizontal: appTheme.spacing.panel,
              paddingTop: appTheme.spacing.gap,
            }}
          >
            <PrimaryButton
              accessibilityHint="Restarts Magicbooklet to finish updating"
              label="Restart now"
              onPress={onRestart}
            />
            <SecondaryButton
              accessibilityHint="Keeps working; the update finishes later on its own"
              label="Not now"
              onPress={onDismiss}
            />
          </View>
        </SheetPanel>
      </View>
    </Modal>
  );
}
