import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { useEffect, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Platform, Pressable, type ViewStyle } from 'react-native';

import { appTheme } from '@/lib/theme';
import { viewerTopControlTop, VIEWER_TOP_CONTROL_SIZE } from '@/lib/viewer-chrome';

type ViewerTopControlProps = {
  label: string;
  onPress: () => void;
  topInset: number;
  side: 'left' | 'right';
  selected?: boolean;
  children: ReactNode;
};

/** The reel's Back and sound controls share one fixed, accessible glass surface. */
export function ViewerTopControl({ label, onPress, topInset, side, selected, children }: ViewerTopControlProps) {
  const [glassAvailable] = useState(() => (
    Platform.OS === 'ios' && isLiquidGlassAvailable() && isGlassEffectAPIAvailable()
  ));
  const [reduceTransparency, setReduceTransparency] = useState(false);

  useEffect(() => {
    if (!glassAvailable) return;
    let mounted = true;
    void AccessibilityInfo.isReduceTransparencyEnabled().then((enabled) => {
      if (mounted) setReduceTransparency(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceTransparencyChanged', setReduceTransparency);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, [glassAvailable]);

  const glass = glassAvailable && !reduceTransparency;
  const frame: ViewStyle = {
    position: 'absolute',
    [side]: 16,
    top: viewerTopControlTop(topInset),
    width: VIEWER_TOP_CONTROL_SIZE,
    height: VIEWER_TOP_CONTROL_SIZE,
    borderRadius: VIEWER_TOP_CONTROL_SIZE / 2,
    borderCurve: 'continuous',
  };
  const content: ViewStyle = {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: VIEWER_TOP_CONTROL_SIZE / 2,
  };

  if (glass) {
    return (
      <GlassView glassEffectStyle="regular" isInteractive style={frame}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={selected === undefined ? undefined : { selected }}
          onPress={onPress}
          style={content}
        >
          {children}
        </Pressable>
      </GlassView>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        ...frame,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.3)',
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      {children}
    </Pressable>
  );
}
