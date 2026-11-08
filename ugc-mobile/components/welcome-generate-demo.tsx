import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Sparkles, WandSparkles } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, View } from 'react-native';

import { AppText } from '@/components/ui';
import { useReducedMotion } from '@/lib/motion';
import { appTheme, mediaColors, type ThemeColorName } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

import heroInput from '../assets/images/welcome-demo/hero-input.jpg';
import heroOutput from '../assets/images/welcome-demo/hero-output.jpg';
import boatPoster from '../assets/images/welcome-demo/boat-poster.jpg';
import boatClip from '../assets/images/welcome-demo/boat.mp4';

/**
 * The sign-up sheet's demo (`app/join.tsx`): a short loop of the product
 * doing its one job — an input, a prompt, Generate, the
 * result. Both examples are real public posts on Magicbooklet:
 *  - "minnal2.0" by @batman, a remix of @testcreator123's "minnal vanitha"
 *    (Nano Banana 2, the source post's picture as its input);
 *  - the paper-boat clip by @batman (Grok Imagine, text to video).
 */
type DemoExample = {
  kind: 'image' | 'video';
  /** What goes in: a picture, or nothing for a prompt-only run. */
  input: number | null;
  output: number;
  clip?: number;
  prompt: string;
  model: string;
  credit: string;
  tone: ThemeColorName;
};

const EXAMPLES: DemoExample[] = [
  {
    kind: 'image',
    input: heroInput,
    output: heroOutput,
    prompt: 'Hero stance, village at dusk',
    model: 'Nano Banana 2',
    credit: 'Remix by @batman',
    tone: 'image',
  },
  {
    kind: 'video',
    input: null,
    output: boatPoster,
    clip: boatClip,
    prompt: 'Paper boat on a sunlit pond',
    model: 'Grok Imagine',
    credit: '@batman',
    tone: 'video',
  },
];

// One example's timeline, in milliseconds.
const TOTAL = 7400;
const TYPE_START = 350;
const TYPE_END = 1900;
const PRESS_AT = 2050;
const GENERATE_AT = 2300;
const SHRINK_START = 3300;
const REVEAL_START = 3650;
const REVEAL_END = 4250;
const CREDIT_AT = 4450;
const FADE_OUT = 6900;

type Phase = 'typing' | 'ready' | 'generating' | 'done';

const at = (ms: number) => ms / TOTAL;

export function WelcomeGenerateDemo({ width, height }: { width: number; height: number }) {
  const theme = useAppTheme();
  const reducedMotion = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [typed, setTyped] = useState(0);
  const [phase, setPhase] = useState<Phase>('typing');
  const t = useRef(new Animated.Value(0, { useNativeDriver: true })).current;
  const example = EXAMPLES[index];

  // A clip bundled with the app, always muted: it never takes the audio
  // session from music already playing.
  const player = useVideoPlayer(boatClip, (instance) => {
    instance.audioMixingMode = 'auto';
    instance.muted = true;
    instance.loop = true;
  });

  // The frame is a tall card: the picture, with the prompt bar under it.
  const promptBarHeight = 52;
  const frameHeight = Math.max(240, height - promptBarHeight - 18);
  const frameWidth = Math.min(width - 48, Math.round(frameHeight * 0.6));
  const thumb = 0.3;
  const inset = 10;

  useEffect(() => {
    if (reducedMotion) {
      t.setValue(at(CREDIT_AT + 200));
      setTyped(example.prompt.length);
      setPhase('done');
      return;
    }

    t.setValue(0);
    setTyped(0);
    setPhase('typing');
    player.pause();
    player.currentTime = 0;

    const timers: ReturnType<typeof setTimeout>[] = [];
    const chars = example.prompt.length;
    const step = (TYPE_END - TYPE_START) / chars;
    for (let i = 1; i <= chars; i += 1) {
      timers.push(setTimeout(() => setTyped(i), TYPE_START + step * i));
    }
    timers.push(setTimeout(() => setPhase('ready'), TYPE_END));
    timers.push(setTimeout(() => setPhase('generating'), GENERATE_AT));
    timers.push(setTimeout(() => {
      setPhase('done');
      if (example.kind === 'video') player.play();
    }, REVEAL_START));

    const run = Animated.timing(t, {
      toValue: 1,
      duration: TOTAL,
      easing: Easing.linear,
      useNativeDriver: true,
    });
    run.start(({ finished }) => {
      if (finished) setIndex((current) => (current + 1) % EXAMPLES.length);
    });

    return () => {
      run.stop();
      timers.forEach(clearTimeout);
    };
  }, [example, index, player, reducedMotion, t]);

  const fade = t.interpolate({
    inputRange: [0, at(250), at(FADE_OUT), 1],
    outputRange: [0, 1, 1, 0],
    extrapolate: 'clamp',
  });

  // The input sits full size while the prompt is typed, then settles into the
  // corner as the result arrives, so the before stays in view beside the after.
  const shrink = t.interpolate({
    inputRange: [at(SHRINK_START), at(REVEAL_START + 150)],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const inputScale = shrink.interpolate({ inputRange: [0, 1], outputRange: [1, thumb] });
  const inputX = shrink.interpolate({
    inputRange: [0, 1],
    outputRange: [0, inset + (frameWidth * thumb) / 2 - frameWidth / 2],
  });
  const inputY = shrink.interpolate({
    inputRange: [0, 1],
    outputRange: [0, inset + (frameHeight * thumb) / 2 - frameHeight / 2],
  });

  // Generating: the input dims and a sheen passes over it twice.
  const dim = t.interpolate({
    inputRange: [at(GENERATE_AT), at(GENERATE_AT + 250), at(SHRINK_START), at(REVEAL_START)],
    outputRange: [0, 0.45, 0.45, 0],
    extrapolate: 'clamp',
  });
  const sheenWidth = frameWidth * 0.7;
  const sheenX = t.interpolate({
    inputRange: [at(GENERATE_AT), at(GENERATE_AT + 650), at(GENERATE_AT + 651), at(REVEAL_START)],
    outputRange: [-sheenWidth, frameWidth, -sheenWidth, frameWidth],
    extrapolate: 'clamp',
  });
  const sheenOpacity = t.interpolate({
    inputRange: [at(GENERATE_AT - 1), at(GENERATE_AT), at(REVEAL_START), at(REVEAL_START + 1)],
    outputRange: [0, 1, 1, 0],
    extrapolate: 'clamp',
  });

  // The result wipes in from the left edge: the clip window slides right while
  // the picture inside slides back by the same amount, so it stays put.
  const reveal = t.interpolate({
    inputRange: [at(REVEAL_START), at(REVEAL_END)],
    outputRange: [-frameWidth, 0],
    extrapolate: 'clamp',
  });
  const revealInner = Animated.multiply(reveal, -1);
  const revealEdge = t.interpolate({
    inputRange: [at(REVEAL_START), at(REVEAL_START + 60), at(REVEAL_END - 60), at(REVEAL_END)],
    outputRange: [0, 1, 1, 0],
    extrapolate: 'clamp',
  });

  const press = t.interpolate({
    inputRange: [at(PRESS_AT), at(PRESS_AT + 120), at(PRESS_AT + 280)],
    outputRange: [1, 0.92, 1],
    extrapolate: 'clamp',
  });
  const creditIn = t.interpolate({
    inputRange: [at(CREDIT_AT), at(CREDIT_AT + 300)],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

  const tone = theme.colors[example.tone];
  const showCaret = phase === 'typing' || phase === 'ready';

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel="A short demo: a picture and a prompt go in, Generate is pressed, and a finished creation comes out."
      style={{ width, height, alignItems: 'center', justifyContent: 'flex-start', paddingTop: 6 }}
    >
      <Animated.View style={{ opacity: fade, alignItems: 'center', gap: 12 }}>
        {/* The frame */}
        <View
          style={{
            width: frameWidth,
            height: frameHeight,
            borderRadius: appTheme.radii.xl,
            borderCurve: 'continuous',
            overflow: 'hidden',
            backgroundColor: theme.colors.surface,
            borderWidth: 1,
            borderColor: theme.colors.border,
          }}
        >
          {/* Prompt-only runs start from an empty canvas. */}
          {example.input === null ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 }}>
              <Sparkles size={appTheme.icon.hero} color={tone} />
              <AppText variant="caption" color="muted">Text to video</AppText>
            </View>
          ) : null}

          {/* The result, revealed by the wipe. */}
          <Animated.View
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: 0,
              width: frameWidth,
              overflow: 'hidden',
              transform: [{ translateX: reveal }],
            }}
          >
            <Animated.View style={{ width: frameWidth, height: frameHeight, transform: [{ translateX: revealInner }] }}>
              <Image source={example.output} contentFit="cover" style={{ width: '100%', height: '100%' }} />
              {example.kind === 'video' ? (
                <VideoView
                  player={player}
                  nativeControls={false}
                  contentFit="cover"
                  pointerEvents="none"
                  style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: phase === 'done' ? 1 : 0 }}
                />
              ) : null}
            </Animated.View>
          </Animated.View>
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: frameWidth - 2,
              width: 3,
              backgroundColor: tone,
              opacity: revealEdge,
              transform: [{ translateX: reveal }],
            }}
          />

          {/* The input: full size, then a thumbnail in the corner. */}
          {example.input !== null ? (
            <Animated.View
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: frameWidth,
                height: frameHeight,
                borderRadius: appTheme.radii.xl,
                borderCurve: 'continuous',
                overflow: 'hidden',
                borderWidth: 4,
                borderColor: mediaColors.onMedia,
                transform: [{ translateX: inputX }, { translateY: inputY }, { scale: inputScale }],
              }}
            >
              <Image source={example.input} contentFit="cover" style={{ width: '100%', height: '100%' }} />
              <Animated.View
                pointerEvents="none"
                style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: mediaColors.mediaGround, opacity: dim }}
              />
            </Animated.View>
          ) : null}

          {/* The sheen while it generates. */}
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              width: sheenWidth,
              opacity: sheenOpacity,
              transform: [{ translateX: sheenX }, { skewX: '-12deg' }],
            }}
          >
            <LinearGradient
              colors={[`${mediaColors.onMedia}00`, `${mediaColors.onMedia}4d`, `${mediaColors.onMedia}00`]}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={{ flex: 1 }}
            />
          </Animated.View>

          {/* Status: the model while it runs, then the creator's credit. */}
          {phase === 'generating' ? (
            <View style={{ position: 'absolute', top: inset, left: inset, right: inset, alignItems: 'flex-end' }}>
              <StatusChip label={example.model} />
            </View>
          ) : null}
          <Animated.View style={{ position: 'absolute', left: inset, right: inset, bottom: inset, opacity: creditIn }}>
            <StatusChip label={example.credit} />
          </Animated.View>
        </View>

        {/* The prompt bar */}
        <View
          style={{
            width: width - 48,
            height: promptBarHeight,
            borderRadius: appTheme.radii.pill,
            backgroundColor: theme.colors.surface,
            borderWidth: 1,
            borderColor: theme.colors.border,
            flexDirection: 'row',
            alignItems: 'center',
            paddingLeft: 16,
            paddingRight: 5,
            gap: 8,
          }}
        >
          <AppText variant="bodySm" numberOfLines={1} style={{ flex: 1 }}>
            {example.prompt.slice(0, typed)}
            {showCaret ? <AppText variant="bodySm" style={{ color: tone }}>|</AppText> : null}
          </AppText>
          <Animated.View
            style={{
              height: 42,
              paddingHorizontal: 14,
              borderRadius: appTheme.radii.pill,
              backgroundColor: theme.colors.primaryFill,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              opacity: phase === 'typing' ? 0.55 : 1,
              transform: [{ scale: press }],
            }}
          >
            <WandSparkles size={16} color={theme.colors.onPrimary} />
            <AppText variant="bodySm" style={{ color: theme.colors.onPrimary, fontWeight: '700' }}>
              {phase === 'generating' ? 'Generating' : 'Generate'}
            </AppText>
          </Animated.View>
        </View>
      </Animated.View>
    </View>
  );
}

function StatusChip({ label }: { label: string }) {
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: appTheme.radii.pill,
        backgroundColor: mediaColors.mediaChip,
      }}
    >
      <AppText variant="caption" numberOfLines={1} style={{ color: mediaColors.onMedia, fontWeight: '600' }}>
        {label}
      </AppText>
    </View>
  );
}
