import { Lock } from 'lucide-react-native';
import { ActivityIndicator, Modal, Pressable, Text, View } from 'react-native';

import { ResourceKindRow } from '@/components/resource-kind-row';
import { SheetBackdrop, SheetGrabber, SheetPanel, useSheetDismissDrag } from '@/components/sheet-chrome';
import { useAuth } from '@/lib/auth';
import type { ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';
import { useReducedMotion } from '@/lib/motion';
import { CloseGlyph } from '@/lib/platform-glyphs';
import { hexWithAlpha } from '@/lib/eased-fade';
import { accentColor, appTheme, type ToolAccent } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import { useBundleUnlock } from '@/lib/use-bundle-unlock';

export function UnlockRemixPrompt({
  bottomInset,
  item,
  onClose,
  onUnlocked,
  authReturnTo,
  visible,
}: {
  authReturnTo?: string;
  bottomInset: number;
  item: ImmersivePreviewItem | null;
  onClose: () => void;
  onUnlocked: (item: ImmersivePreviewItem) => void | Promise<void>;
  visible: boolean;
}) {
  const theme = useAppTheme();
  const { user } = useAuth();
  const reducedMotion = useReducedMotion();
  const drag = useSheetDismissDrag({ onDismiss: onClose, visible });
  const unlock = item?.details?.unlock ?? null;
  // The feed's price for this bundle, when the item carries the bundle it names.
  const resource = item?.resource && unlock && item.resource.resourceId === unlock.resourceId ? item.resource : null;
  const bundleUnlock = useBundleUnlock({
    authReturnTo,
    // This sheet is an RN Modal, which would hide the action sheet the other
    // hosts ask with; the dialog draws above it.
    confirmWith: 'dialog',
    onLeave: onClose,
    onUnlocked: async () => {
      if (!item) return;
      onClose();
      await onUnlocked(item);
    },
    target: unlock
      ? {
        postId: unlock.postId,
        resourceId: unlock.resourceId,
        accessMode: unlock.accessMode,
        priceUsdCents: typeof resource?.priceUsdCents === 'number' ? resource.priceUsdCents : null,
        priceLabel: unlock.priceLabel,
      }
      : null,
  });
  const accent: ToolAccent = unlock?.accessMode === 'free' ? 'workflow' : 'commerce';
  const accentValue = accentColor(accent, theme.colors);
  const resourceKinds = unlock?.resourceKinds ?? [];
  // A paid unlock spends credits once confirmed, so the button says how many.
  const ctaLabel = !user
    ? 'Sign in to unlock'
    : unlock?.accessMode === 'paid' && unlock.priceLabel
      ? `Unlock for ${unlock.priceLabel}`
      : 'Unlock to remix';
  const ctaDisabled = bundleUnlock.isPending || bundleUnlock.shortfall > 0;

  if (!item || !unlock) {
    return null;
  }

  return (
    <Modal
      accessibilityViewIsModal
      animationType={reducedMotion ? 'none' : 'fade'}
      onRequestClose={onClose}
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <SheetBackdrop drag={drag} color={hexWithAlpha(theme.dim.color, 0.62 * theme.dim.scale)} label="Close unlock prompt" onPress={onClose} />
        <SheetPanel
          {...drag.contentPanHandlers}
          style={[
            {
              borderTopLeftRadius: appTheme.radii.xl,
              borderTopRightRadius: appTheme.radii.xl,
              borderCurve: 'continuous',
              borderWidth: 1,
              borderBottomWidth: 0,
              borderColor: `${accentValue}55`,
              backgroundColor: theme.colors.app,
              paddingHorizontal: 22,
              paddingBottom: bottomInset + 24,
              gap: appTheme.spacing.gap,
            },
            drag.dragStyle,
          ]}
        >
          <SheetGrabber drag={drag} />
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
            <View style={{ flex: 1, gap: 5 }}>
              <Text style={{ color: theme.colors.faint, ...appTheme.type.label, textTransform: 'uppercase' }}>
                Remix locked
              </Text>
              <Text style={{ color: theme.colors.text, ...appTheme.type.cardTitle, fontWeight: '800' }}>
                Unlock resources to remix
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close unlock prompt"
              onPress={onClose}
              style={({ pressed }) => ({
                width: 48,
                height: 48,
                borderRadius: 24,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: theme.colors.surfaceStrong,
                opacity: pressed ? appTheme.opacity.pressed : 1,
              })}
            >
              <CloseGlyph size={appTheme.icon.feature} color={theme.colors.text} />
            </Pressable>
          </View>

          <View style={{ borderRadius: appTheme.radii.xl, borderCurve: 'continuous', backgroundColor: theme.colors.surfaceStrong, padding: appTheme.spacing.card, gap: appTheme.spacing.gap }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
              <View style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: `${accentValue}22` }}>
                <Lock size={20} color={accentValue} />
              </View>
              <View style={{ flex: 1, gap: 5 }}>
                <Text style={{ color: theme.colors.text, ...appTheme.type.bodySm, fontWeight: '800' }}>
                  {unlock.title || item.title}
                </Text>
                <Text style={{ color: theme.colors.muted, ...appTheme.type.bodySm }}>
                  {unlock.previewText || 'Unlock the creator resources attached to this post, then remix it in the editor.'}
                </Text>
              </View>
              {unlock.priceLabel ? (
                <View style={{ borderRadius: appTheme.radii.pill, backgroundColor: `${accentValue}24`, paddingHorizontal: 10, paddingVertical: 6 }}>
                  <Text style={{ color: accentValue, ...appTheme.type.caption, fontWeight: '800' }}>{unlock.priceLabel}</Text>
                </View>
              ) : null}
            </View>
            <ResourceKindRow kinds={resourceKinds} on="surfaceStrong" />
          </View>

          {bundleUnlock.shortfallMessage ? (
            <Text style={{ color: theme.semantic.warning.foreground, ...appTheme.type.caption, fontWeight: '800' }}>
              {bundleUnlock.shortfallMessage}
            </Text>
          ) : null}
          {bundleUnlock.error ? <Text selectable style={{ color: theme.colors.danger, ...appTheme.type.caption, fontWeight: '800' }}>{bundleUnlock.error}</Text> : null}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={ctaLabel}
            accessibilityState={{ disabled: ctaDisabled }}
            disabled={ctaDisabled}
            onPress={bundleUnlock.request}
            style={({ pressed }) => ({
              minHeight: 50,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 9,
              borderRadius: appTheme.radii.pill,
              backgroundColor: theme.colors.primaryFill,
              opacity: ctaDisabled ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1,
              paddingHorizontal: 18,
            })}
          >
            {bundleUnlock.isPending ? (
              <ActivityIndicator color={theme.colors.onPrimary} />
            ) : (
              <Lock size={appTheme.icon.default} color={theme.colors.onPrimary} />
            )}
            <Text style={{ color: theme.colors.onPrimary, ...appTheme.type.bodySm, fontWeight: '800' }}>
              {bundleUnlock.isPending ? 'Unlocking…' : ctaLabel}
            </Text>
          </Pressable>
          {bundleUnlock.offersCredits ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Get credits"
              onPress={bundleUnlock.goToCredits}
              style={({ pressed }) => ({
                minHeight: 50,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: appTheme.radii.pill,
                backgroundColor: theme.colors.surfaceStrong,
                opacity: pressed ? appTheme.opacity.pressed : 1,
                paddingHorizontal: 18,
              })}
            >
              <Text style={{ color: theme.colors.text, ...appTheme.type.bodySm, fontWeight: '800' }}>Get credits</Text>
            </Pressable>
          ) : null}
        </SheetPanel>
      </View>
    </Modal>
  );
}
