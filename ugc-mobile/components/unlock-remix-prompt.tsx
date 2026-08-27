import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { FileText, Lock } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, Text, View } from 'react-native';

import { SheetGrabber, SheetPanel, useSheetDismissDrag } from '@/components/sheet-chrome';
import { useAuth } from '@/lib/auth';
import type { ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';
import { useReducedMotion } from '@/lib/motion';
import { CloseGlyph } from '@/lib/platform-glyphs';
import { accentColor, appTheme, type ToolAccent } from '@/lib/theme';
import type { PostResourceKind } from '@/lib/types';
import { refreshUnlockedBundleCaches } from '@/lib/unlock-cache';
import { haptic } from '@/lib/haptics';

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
  const { api, user } = useAuth();
  const queryClient = useQueryClient();
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reducedMotion = useReducedMotion();
  const drag = useSheetDismissDrag({ onDismiss: onClose, visible });
  const unlock = item?.details?.unlock ?? null;
  const accent: ToolAccent = unlock?.accessMode === 'free' ? 'workflow' : 'commerce';
  const accentValue = accentColor(accent);
  const resourceKinds = unlock?.resourceKinds ?? [];
  const ctaLabel = user ? 'Unlock to remix' : 'Sign in to unlock';

  const handleUnlock = async () => {
    if (!item || !unlock) return;

    if (!user) {
      onClose();
      router.push({ pathname: '/auth', params: { returnTo: authReturnTo } } as never);
      return;
    }

    try {
      setError(null);
      setUnlocking(true);
      if (unlock.accessMode === 'free') {
        await api.unlockFreeBundle(unlock.postId);
      } else {
        await api.unlockBundleWithCredits(unlock.postId);
      }

      await refreshUnlockedBundleCaches(queryClient, unlock);
      haptic.select();
      setUnlocking(false);
      onClose();
      await onUnlocked(item);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not unlock this resource.');
      setUnlocking(false);
    }
  };

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
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.62)' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close unlock prompt"
          onPress={onClose}
          style={{ position: 'absolute', inset: 0 }}
        />
        <SheetPanel
          style={[
            {
              borderTopLeftRadius: appTheme.radii.xl,
              borderTopRightRadius: appTheme.radii.xl,
              borderCurve: 'continuous',
              borderWidth: 1,
              borderBottomWidth: 0,
              borderColor: `${accentValue}55`,
              backgroundColor: appTheme.colors.app,
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
              <Text style={{ color: appTheme.colors.faint, ...appTheme.type.label, textTransform: 'uppercase' }}>
                Remix locked
              </Text>
              <Text style={{ color: appTheme.colors.text, ...appTheme.type.cardTitle, fontWeight: '800' }}>
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
                backgroundColor: appTheme.colors.surfaceStrong,
                opacity: pressed ? appTheme.opacity.pressed : 1,
              })}
            >
              <CloseGlyph size={appTheme.icon.feature} color={appTheme.colors.text} />
            </Pressable>
          </View>

          <View style={{ borderRadius: appTheme.radii.xl, borderCurve: 'continuous', backgroundColor: appTheme.colors.surfaceStrong, padding: appTheme.spacing.card, gap: appTheme.spacing.gap }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
              <View style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: `${accentValue}22` }}>
                <Lock size={20} color={accentValue} />
              </View>
              <View style={{ flex: 1, gap: 5 }}>
                <Text style={{ color: appTheme.colors.text, ...appTheme.type.bodySm, fontWeight: '800' }}>
                  {unlock.title || item.title}
                </Text>
                <Text style={{ color: appTheme.colors.muted, ...appTheme.type.bodySm }}>
                  {unlock.previewText || 'Unlock the creator resources attached to this post, then remix it in the editor.'}
                </Text>
              </View>
              {unlock.priceLabel ? (
                <View style={{ borderRadius: appTheme.radii.pill, backgroundColor: `${accentValue}24`, paddingHorizontal: 10, paddingVertical: 6 }}>
                  <Text style={{ color: accentValue, ...appTheme.type.caption, fontWeight: '800' }}>{unlock.priceLabel}</Text>
                </View>
              ) : null}
            </View>
            <ResourceKindRow kinds={resourceKinds} />
          </View>

          {error ? <Text selectable style={{ color: appTheme.colors.danger, ...appTheme.type.caption, fontWeight: '800' }}>{error}</Text> : null}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={ctaLabel}
            disabled={unlocking}
            onPress={() => {
              void handleUnlock();
            }}
            style={({ pressed }) => ({
              minHeight: 50,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 9,
              borderRadius: appTheme.radii.pill,
              backgroundColor: appTheme.colors.primary,
              opacity: unlocking ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1,
              paddingHorizontal: 18,
            })}
          >
            {unlocking ? (
              <ActivityIndicator color={appTheme.colors.textInverse} />
            ) : (
              <Lock size={appTheme.icon.default} color={appTheme.colors.textInverse} />
            )}
            <Text style={{ color: appTheme.colors.textInverse, ...appTheme.type.bodySm, fontWeight: '800' }}>
              {unlocking ? 'Unlocking…' : ctaLabel}
            </Text>
          </Pressable>
        </SheetPanel>
      </View>
    </Modal>
  );
}

function ResourceKindRow({ kinds }: { kinds: PostResourceKind[] }) {
  if (!kinds.length) return null;

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {kinds.map((kind) => (
        <View key={kind} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: appTheme.radii.pill, backgroundColor: appTheme.colors.surface, paddingHorizontal: 10, paddingVertical: 6 }}>
          <FileText size={appTheme.icon.xs} color={appTheme.colors.textSecondary} />
          <Text style={{ color: appTheme.colors.text, ...appTheme.type.caption, fontWeight: '800' }}>{resourceKindLabel(kind)}</Text>
        </View>
      ))}
    </View>
  );
}

function resourceKindLabel(kind: PostResourceKind) {
  if (kind === 'prompt') return 'Prompt';
  if (kind === 'workflow') return 'Workflow';
  if (kind === 'files') return 'Files';
  if (kind === 'notes') return 'Notes';
  return 'Remix';
}
