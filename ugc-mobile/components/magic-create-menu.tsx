import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { FilePlus2, Sparkles, X } from 'lucide-react-native';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CREATE_MENU_ACTIONS, type CreateMenuAction, type CreateMenuActionId } from '@/lib/create-menu-view-model';
import { resolvedBottomInset } from '@/lib/safe-area';

export function MagicCreateMenu({
  visible,
  onClose,
  onAction,
  horizontalInset = 0,
  bottomInset = 0,
}: {
  visible: boolean;
  onClose: () => void;
  onAction: (id: CreateMenuActionId) => void;
  horizontalInset?: number;
  bottomInset?: number;
}) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const safeBottom = resolvedBottomInset(insets.bottom);
  const panelWidth = Math.max(width * 1.26, 520);
  const panelHeight = 308 + safeBottom;
  const actionWidth = Math.max(132, Math.min(182, (width - 104) / 2));

  if (!visible) return null;

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: -horizontalInset,
        right: -horizontalInset,
        bottom: -bottomInset,
        height: height + bottomInset + 24,
        zIndex: 40,
        elevation: 40,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss create menu"
        onPress={onClose}
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.64)',
        }}
      >
        <BlurView intensity={34} tint="dark" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} />
      </Pressable>

      <View
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          alignItems: 'center',
        }}
      >
        <BlurView
          intensity={42}
          tint="dark"
          style={{
            width: panelWidth,
            height: panelHeight,
            marginBottom: -104,
            overflow: 'hidden',
            borderTopLeftRadius: panelWidth / 2,
            borderTopRightRadius: panelWidth / 2,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.13)',
            backgroundColor: 'rgba(24,24,27,0.84)',
          }}
        >
          <LinearGradient
            colors={['rgba(255,255,255,0.10)', 'rgba(255,255,255,0.045)', 'rgba(3,4,13,0.18)']}
            style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}
          />
          <View
            style={{
              width,
              alignSelf: 'center',
              paddingTop: 58,
              paddingHorizontal: 38,
            }}
          >
            <View style={{ height: 120, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center', gap: 28 }}>
              {CREATE_MENU_ACTIONS.map((action) => (
                <MenuActionButton key={action.id} action={action} width={actionWidth} onPress={() => onAction(action.id)} />
              ))}
            </View>
          </View>
        </BlurView>
      </View>

      <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: safeBottom + 116, alignItems: 'center' }}>
        <CloseMenuButton onPress={onClose} />
      </View>
    </View>
  );
}

function CloseMenuButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Close create menu"
      onPress={onPress}
      style={({ pressed }) => ({
        width: 62,
        height: 62,
        borderRadius: 31,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.08)',
        backgroundColor: 'rgba(3,4,13,0.68)',
        opacity: pressed ? 0.76 : 1,
        transform: [{ scale: pressed ? 0.96 : 1 }],
        boxShadow: '0 14px 40px rgba(0,0,0,0.38)',
      })}
    >
      <X size={31} color="#ffffff" strokeWidth={2.4} />
    </Pressable>
  );
}

function MenuActionButton({ action, width, onPress }: { action: CreateMenuAction; width: number; onPress: () => void }) {
  const isCreate = action.id === 'create';
  const Icon = isCreate ? Sparkles : FilePlus2;
  const colors: readonly [string, string] = isCreate
    ? ['rgba(217,70,239,0.95)', 'rgba(124,58,237,0.72)']
    : ['rgba(34,211,238,0.72)', 'rgba(52,211,153,0.58)'];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={action.label}
      onPress={onPress}
      style={({ pressed }) => ({
        width,
        height: 120,
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: 12,
        opacity: pressed ? 0.76 : 1,
        transform: [{ translateY: pressed ? 2 : 0 }],
      })}
    >
      <LinearGradient
        colors={colors}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{
          width: 72,
          height: 72,
          borderRadius: 36,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.18)',
          boxShadow: isCreate ? '0 12px 36px rgba(217,70,239,0.30)' : '0 12px 36px rgba(34,211,238,0.22)',
        }}
      >
        <Icon size={32} color="#ffffff" strokeWidth={2.3} />
      </LinearGradient>
      <View style={{ alignItems: 'center' }}>
        <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.76} style={{ color: '#ffffff', fontSize: 17, fontWeight: '900' }}>
          {action.label}
        </Text>
      </View>
    </Pressable>
  );
}
