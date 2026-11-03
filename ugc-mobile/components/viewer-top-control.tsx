import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { useEffect, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform, Pressable, type ViewStyle } from 'react-native';

import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import { viewerTopControlTop, VIEWER_TOP_CONTROL_SIZE } from '@/lib/viewer-chrome';
import { useViewerTopControlsShown } from '@/lib/viewer-top-controls';

/** How long the control takes to come in or go (seconds, as UIKit's glass animation takes it). */
const APPEARANCE_S = 0.2;

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
  // The reel's scope is dark in both schemes. The glass has to be told: left on
  // 'auto' it follows the window, and a light-mode window would put light glass
  // over the video.
  const theme = useAppTheme();
  // Not seen under UIKit's zoom into the reel until the push has crossfaded,
  // nor once a close has begun (lib/viewer-top-controls.ts).
  const shown = useViewerTopControlsShown();
  const [glassAvailable] = useState(() => (
    Platform.OS === 'ios' && isLiquidGlassAvailable() && isGlassEffectAPIAvailable()
  ));
  const [reduceTransparency, setReduceTransparency] = useState(false);
  // Glass is not faded with opacity: under an ancestor whose opacity changed it
  // never rendered its effect again (simulator, 2026-11-03). It materialises
  // through its own style instead, and only what it holds fades.
  const [appearance] = useState(() => new Animated.Value(shown ? 1 : 0, { useNativeDriver: true }));

  useEffect(() => {
    const animation = Animated.timing(appearance, {
      toValue: shown ? 1 : 0,
      duration: APPEARANCE_S * 1000,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [appearance, shown]);

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
      <GlassView
        glassEffectStyle={{ style: shown ? 'regular' : 'none', animate: true, animationDuration: APPEARANCE_S }}
        colorScheme={theme.scheme}
        isInteractive
        style={frame}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          // An object in every state, as hig-accessibility-label-states asks:
          // Android keeps a state that reaches it as undefined. A `selected`
          // left undefined (the Back control) is simply not sent.
          accessibilityState={{ selected }}
          onPress={onPress}
          style={content}
        >
          <Animated.View style={{ opacity: appearance }}>{children}</Animated.View>
        </Pressable>
      </GlassView>
    );
  }

  return (
    <Animated.View style={[frame, { opacity: appearance }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected }}
        onPress={onPress}
        style={({ pressed }) => ({
          ...content,
          backgroundColor: 'rgba(0,0,0,0.3)',
          opacity: pressed ? appTheme.opacity.pressed : 1,
        })}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}
