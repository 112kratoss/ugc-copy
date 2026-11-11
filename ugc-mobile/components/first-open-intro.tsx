// The first time the app opens on an install (`components/first-open-intro-host.tsx`
// decides when), after the logo, "Create / Share / Earn" arrives a line at a
// time with a handwritten note beside each word, holds, then turns to dust and
// blows away (the owner's brief, 2026-11-06: "the way Thanos snapped"); a note
// from the team comes in as it goes, and its button lifts the page off the
// screen beneath (Home, for a new install).
//
// No Skia in this binary (adding it is a store build), so the dust is built
// from the words themselves: each word is cut into a grid of small tiles, every
// tile a clipped window onto the same text, so together they draw the word
// exactly. At the snap the whole word is swapped for its tiles (an invisible
// swap) and each tile drifts up and to the right, turns, shrinks and fades,
// started in a sweep from the left with some scatter. Everything runs on two
// Animated values on the native driver.
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View, type TextStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useDisplayFontLoaded } from '@/lib/display-font-ready';
import { launchSplashGround } from '@/lib/launch-splash';
import { useReducedMotion } from '@/lib/motion';
import { useHardwareBack } from '@/lib/use-hardware-back';
import { appTheme, DISPLAY_FONT, themes, type ThemeColorName } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

import { haptic } from '@/lib/haptics';

// Caveat Bold (SIL Open Font License, `assets/fonts/Caveat-OFL.txt`), the
// handwriting of the notes and the signature. The file itself is carried
// rather than the @expo-google-fonts package: a new dependency changes the
// app's runtime fingerprint, and the intro has to reach the builds in use.
import Caveat_700Bold from '../assets/fonts/Caveat_700Bold.ttf';

// Each line: the keyword, big and in its colour, with a handwritten note
// beside it, as if scribbled on a poster (owner, 2026-11-07: the notes
// placed where they marked them on a screenshot, "create something, share with
// others, earn something", in other words).
const WORDS: { lead: string; note: string; tone: ThemeColorName }[] = [
  { lead: 'Create', note: 'anything', tone: 'primary' },
  { lead: 'Share', note: 'the magic', tone: 'image' },
  { lead: 'Earn', note: 'as it grows', tone: 'motion' },
];

// Timeline (ms).
const WORD_IN = 750; // each word's arrival
const WORD_GAP = 700; // between one word starting and the next (owner, 2026-11-07: quicker)
const NOTE_WRITE = 650; // a note being written, once its word has landed
const HOLD = 400; // everything on screen before the dust (owner, 2026-11-07: "little quicker")
const SNAP = 2800; // the dust
const FADE_OUT = 380; // the page lifting off the screen beneath
// Tile edge, in points. 6 read finest but made ~1,200 animated views (owner,
// 2026-11-07: "i think it will lag"); 8 keeps it near 700, and the early
// shrink below does most of the work of making them read as grains.
const TILE = 8;
const ENTER = 460; // the page sliding in over the logo's ground
const NOTE_GAP = 10; // between a word and its note
const NOTE_ROOM = 120; // the room kept for the notes until they are measured
// How far Dynamic Type may grow the big words, their notes and the signature.
// They are display type, laid out across the screen and cut into dust tiles,
// so they grow a little (HIG: large titles scale less than body text) where
// the note's paragraph follows the reader as far as body text does.
const DECORATIVE_SCALE = 1.15;

// A note from the team, coming in as the words blow away (owner, 2026-11-07:
// "as the texts fade, a para with the headline, a note from the team … -magic
// booklet"), read at the reader's pace and left with a button.
const LETTER = {
  headline: 'A note from the team',
  // The name sits between these two, drawn in the logo's colours.
  bodyBefore: 'Thank you for downloading ',
  bodyAfter:
    '. We’re building a kind, creative community where anyone can make something amazing, share it, and earn when others build on it. We’re so glad you’re here.',
  signature: '— Magicbooklet',
  // It opens onto Home for a new install: this button only moves on, and
  // says where to (owner, 2026-11-11: "make it explore").
  action: 'Explore',
};
const LETTER_START = 0.55; // how far into the dust the note starts to come in
// The note's own timeline (ms): headline, then the paragraph, then the
// signature written in, then the button.
const LETTER_HEAD = [0, 500];
const LETTER_BODY = [300, 1100];
const LETTER_SIGN = [1250, 2150];
const LETTER_ACTION = [2150, 2550];
const LETTER_TOTAL = 2550;

/**
 * When each letter of a note is reached by the writing, as a share of the
 * writing time: the reveal runs left to right at an even pace, so a letter is
 * reached in proportion to the width before it. Rough widths are enough.
 */
function letterTimes(note: string) {
  const width = (ch: string) => (ch === ' ' ? 0.55 : 'mw'.includes(ch) ? 1.2 : 'ilt'.includes(ch) ? 0.5 : 0.8);
  const total = [...note].reduce((sum, ch) => sum + width(ch), 0);
  const times: number[] = [];
  let before = 0;
  for (const ch of note) {
    if (ch !== ' ') times.push((before + width(ch) * 0.35) / total);
    before += width(ch);
  }
  return times;
}

/** A copy with one size set, or the same array when nothing changed. */
function withSize(list: (Size | null)[], at: number, width: number, height: number) {
  const current = list[at];
  if (current && Math.abs(current.width - width) < 0.5 && Math.abs(current.height - height) < 0.5) return list;
  return list.map((item, index) => (index === at ? { width, height } : item));
}

/** How far the notes reach past the widest word, so the block centres whole. */
function noteRoom(words: (Size | null)[], notes: (Size | null)[]) {
  if (!words.every(Boolean) || !notes.every(Boolean)) return NOTE_ROOM;
  const widest = Math.max(...words.map((size) => size!.width));
  const reach = Math.max(...words.map((size, index) => size!.width + NOTE_GAP + notes[index]!.width));
  return Math.max(0, Math.ceil(reach - widest));
}

const WORD_STYLE: TextStyle = {
  fontFamily: DISPLAY_FONT.extraBold,
  fontSize: 54,
  lineHeight: 62,
  fontWeight: '400',
  letterSpacing: -0.8,
};

const NOTE_STYLE: TextStyle = {
  fontFamily: 'Caveat_700Bold',
  fontSize: 27,
  lineHeight: 32,
  fontWeight: '400',
};

type Phase = 'waiting' | 'appear' | 'snap' | 'letter' | 'leaving';

const SIGN_STYLE: TextStyle = {
  fontFamily: 'Caveat_700Bold',
  fontSize: 34,
  lineHeight: 40,
  fontWeight: '400',
};
type Size = { width: number; height: number };

// A grain's path, sampled at quarters: across at t^1.5, up at t^2.
const EASE_STEPS = [0, 0.25, 0.5, 0.75, 1];
const EASE_IN = EASE_STEPS.map((step) => step ** 1.5);
const EASE_IN_STEEP = EASE_STEPS.map((step) => step ** 2);

/** Repeatable scatter: the same tile always gets the same throw. */
function scatter(seed: number) {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

const APPEAR_TOTAL = WORD_GAP * (WORDS.length - 1) + WORD_IN + NOTE_WRITE;

export function FirstOpenIntro({ onDone, held = false }: { onDone: () => void; /** The logo splash is still over it: draw the ground, start nothing. */ held?: boolean }) {
  const theme = useAppTheme();
  const reducedMotion = useReducedMotion();
  const displayReady = useDisplayFontLoaded();
  const [noteFontLoaded] = useFonts({ Caveat_700Bold });
  const fontReady = displayReady && noteFontLoaded;
  const [phase, setPhase] = useState<Phase>('waiting');
  const [sizes, setSizes] = useState<(Size | null)[]>(() => WORDS.map(() => null));
  const [noteSizes, setNoteSizes] = useState<(Size | null)[]>(() => WORDS.map(() => null));
  const [appear] = useState(() => new Animated.Value(0, { useNativeDriver: true }));
  const [snap] = useState(() => new Animated.Value(0, { useNativeDriver: true }));
  const [ground] = useState(() => new Animated.Value(1, { useNativeDriver: true }));
  const [enter] = useState(() => new Animated.Value(0, { useNativeDriver: true }));
  const [letter] = useState(() => new Animated.Value(0, { useNativeDriver: true }));
  const [entered, setEntered] = useState(false);
  const [letterRead, setLetterRead] = useState(false);
  // How many lines have their dust built. Each line's grains (a few hundred
  // views) are made just after that line lands rather than all at the start,
  // so the work is spread over the arrival and the hold is not held up by it.
  const [dustBuilt, setDustBuilt] = useState(0);
  // Each tile is a window onto the whole word, and on iOS every one of them
  // keeps a bitmap of the whole word: about 110 MB at the peak on the iPhone
  // simulator. They are let go the moment the dust has blown away.
  const [dustGone, setDustGone] = useState(false);
  const [signWidth, setSignWidth] = useState(0);
  const { width: screenWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const measured = sizes.every(Boolean) && noteSizes.every(Boolean);
  // Worked out once, from the first full measurement: centring the block moves
  // it, and a room that followed every new measurement fed back into itself
  // (the JS thread rendered without end and no timer ever ran).
  const [room, setRoom] = useState<number | null>(null);
  useEffect(() => {
    if (room === null && measured) setRoom(noteRoom(sizes, noteSizes));
  }, [measured, noteSizes, room, sizes]);
  // Its own page, after the logo (owner, 2026-11-07: "a next page rather than
  // the splash screen"): the onboarding's dark ground, pushed in from the right
  // over the logo's, as the next screen of a stack is.
  const page = themes.dark;

  useEffect(() => {
    if (held) return;
    Animated.timing(enter, {
      toValue: 1,
      duration: reducedMotion ? 200 : ENTER,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(() => setEntered(true));
  }, [enter, held, reducedMotion]);

  // Start once both faces are in (or after a short wait for them): text
  // measured in the system face would be cut into the wrong tiles.
  const [fontWaitOver, setFontWaitOver] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setFontWaitOver(true), 1500);
    return () => clearTimeout(timer);
  }, []);
  const canStart = (fontReady || fontWaitOver) && measured && !held && entered;

  // Every timer the timeline starts, cleared if the intro goes before they
  // run. The timeline's own effect re-runs as the phase moves, so its cleanup
  // cannot be where they are cleared.
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => {
    for (const timer of timers.current) clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!canStart || phase !== 'waiting') return;
    setPhase('appear');
    const later = (run: () => void, ms: number) => {
      timers.current.push(setTimeout(run, ms));
    };
    // A tick is only worth feeling as its letter appears. JS timers wait while
    // the app is in the background and then all run together on its return:
    // a tick that comes late is dropped rather than buzzed in a burst.
    const tickAt = (ms: number) => {
      const due = Date.now() + ms;
      later(() => {
        if (Date.now() - due < 120) haptic.soft();
      }, ms);
    };
    // The note arriving is said out loud, so VoiceOver and TalkBack users
    // know the page has changed under them.
    const announceLetter = () => {
      AccessibilityInfo.announceForAccessibility(`${LETTER.headline}. ${LETTER.bodyBefore}Magicbooklet${LETTER.bodyAfter}`);
    };

    if (reducedMotion) {
      // Reduce Motion: the words come in together and stay, then cross-fade
      // to the note, which arrives whole.
      Animated.sequence([
        Animated.timing(appear, { toValue: 1, duration: 400, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.delay(HOLD + 900),
      ]).start(() => {
        setPhase('letter');
        announceLetter();
        Animated.parallel([
          Animated.timing(appear, { toValue: 0, duration: 400, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.timing(letter, { toValue: 1, duration: 400, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        ]).start(() => setLetterRead(true));
      });
      return;
    }

    // The note comes in while the dust is still blowing, and its signature
    // ticks as it is written, as the words' notes did.
    const startLetter = () => {
      setPhase('letter');
      announceLetter();
      letterTimes(LETTER.signature).forEach((at) => {
        tickAt(LETTER_SIGN[0] + at * (LETTER_SIGN[1] - LETTER_SIGN[0]));
      });
      Animated.timing(letter, { toValue: 1, duration: LETTER_TOTAL, easing: Easing.linear, useNativeDriver: true }).start(() => setLetterRead(true));
    };

    // A soft tick for each letter as it is written, the way a chat app ticks
    // while a reply types out (owner, 2026-11-07). Spaces are a pause.
    WORDS.forEach((_, wordIndex) => {
      later(() => setDustBuilt((built) => Math.max(built, wordIndex + 1)), WORD_GAP * wordIndex + WORD_IN);
    });
    WORDS.forEach((word, wordIndex) => {
      const noteStart = WORD_GAP * wordIndex + WORD_IN * 0.7;
      letterTimes(word.note).forEach((at) => {
        tickAt(noteStart + at * NOTE_WRITE);
      });
    });

    Animated.timing(appear, { toValue: 1, duration: APPEAR_TOTAL, easing: Easing.linear, useNativeDriver: true }).start(() => {
      later(() => {
        setPhase('snap');
        Animated.timing(snap, { toValue: 1, duration: SNAP, easing: Easing.linear, useNativeDriver: true }).start(() => setDustGone(true));
        later(startLetter, SNAP * LETTER_START);
      }, HOLD);
    });
  }, [appear, canStart, letter, phase, reducedMotion, snap]);

  const leave = () => {
    if (phase === 'leaving') return;
    setPhase('leaving');
    Animated.timing(ground, { toValue: 0, duration: FADE_OUT, easing: Easing.out(Easing.quad), useNativeDriver: true }).start(onDone);
  };

  // Android's back button lifts the intro off, as Explore does; without this
  // it went to the screen beneath and left the app from behind the intro.
  useHardwareBack(phase !== 'leaving', leave);

  // Never under Reduce Motion: there the words fade with `appear` instead.
  const dusting = !reducedMotion && (phase === 'snap' || phase === 'letter' || phase === 'leaving');
  const showingLetter = phase === 'letter' || phase === 'leaving';
  const letterPart = ([from, to]: number[], rise = 0) => ({
    opacity: letter.interpolate({ inputRange: [from / LETTER_TOTAL, to / LETTER_TOTAL], outputRange: [0, 1], extrapolate: 'clamp' }),
    transform: [{ translateY: letter.interpolate({ inputRange: [from / LETTER_TOTAL, to / LETTER_TOTAL], outputRange: [reducedMotion ? 0 : rise, 0], extrapolate: 'clamp' }) }],
  });
  // The signature is written left to right, the way the notes are.
  const signWrite = letter.interpolate({
    inputRange: [LETTER_SIGN[0] / LETTER_TOTAL, LETTER_SIGN[1] / LETTER_TOTAL],
    outputRange: [reducedMotion ? 0 : -signWidth, 0],
    extrapolate: 'clamp',
  });

  return (
    <Animated.View
      pointerEvents={phase === 'leaving' ? 'none' : 'auto'}
      style={[StyleSheet.absoluteFill, { zIndex: 1000, opacity: ground }]}
    >
      {/* Light status-bar text on the dark page, whatever the phone's scheme. */}
      {entered && phase !== 'leaving' ? <StatusBar style="light" /> : null}
      {/* The logo's ground, under the page as it comes in. */}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: launchSplashGround(theme.scheme) }]} />
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: page.colors.background,
            alignItems: 'center',
            justifyContent: 'center',
            // Reduce Motion: a quick cross-fade in place of the push.
            opacity: reducedMotion ? enter : 1,
            transform: [{ translateX: reducedMotion ? 0 : enter.interpolate({ inputRange: [0, 1], outputRange: [screenWidth, 0] }) }],
          },
        ]}
      >
      {/* Not drawn until the faces are in: iOS keeps the first measurement of a
          string, and one made in the system face cut the words to "Cre…". */}
      {fontReady || fontWaitOver ? (
      // The notes hang off the right of the words, so the block is centred on
      // the words and their notes together, measured once both are laid out.
      <View
        key={fontReady ? 'face' : 'fallback'}
        accessible
        accessibilityLabel="Create anything. Share the magic. Earn as it grows."
        accessibilityElementsHidden={showingLetter}
        importantForAccessibility={showingLetter ? 'no-hide-descendants' : 'auto'}
        style={{ alignItems: 'flex-start', gap: 4, paddingRight: room ?? NOTE_ROOM }}
      >
        {WORDS.map((word, wordIndex) => {
          const start = (WORD_GAP * wordIndex) / APPEAR_TOTAL;
          const end = (WORD_GAP * wordIndex + WORD_IN) / APPEAR_TOTAL;
          const noteStart = (WORD_GAP * wordIndex + WORD_IN * 0.7) / APPEAR_TOTAL;
          const noteEnd = (WORD_GAP * wordIndex + WORD_IN * 0.7 + NOTE_WRITE) / APPEAR_TOTAL;
          const inOpacity = appear.interpolate({ inputRange: [start, end], outputRange: [0, 1], extrapolate: 'clamp' });
          const inRise = appear.interpolate({ inputRange: [start, end], outputRange: [18, 0], extrapolate: 'clamp' });
          const wordStyle: TextStyle = { ...WORD_STYLE, color: page.colors[word.tone] };
          const noteStyle: TextStyle = { ...NOTE_STYLE, color: page.colors.textSecondary };
          const size = sizes[wordIndex];
          const noteSize = noteSizes[wordIndex];
          // The note is written left to right: a window that opens across it.
          const noteWidth = noteSize?.width ?? 0;
          const write = appear.interpolate({ inputRange: [noteStart, noteEnd], outputRange: [reducedMotion ? 0 : -noteWidth, 0], extrapolate: 'clamp' });
          return (
            <View key={word.lead}>
              <Animated.View style={{ opacity: inOpacity, transform: [{ translateY: inRise }] }}>
                {/* The whole word until the snap; it also sets the box the tiles fill. */}
                <Text
                  maxFontSizeMultiplier={DECORATIVE_SCALE}
                  numberOfLines={1}
                  style={[wordStyle, { opacity: dusting ? 0 : 1 }]}
                  onLayout={(event) => {
                    const { width, height } = event.nativeEvent.layout;
                    setSizes((current) => withSize(current, wordIndex, width, height));
                  }}
                >
                  {word.lead}
                </Text>
                {size && !reducedMotion && !dustGone && wordIndex < dustBuilt ? (
                  <WordDust content={word.lead} style={wordStyle} size={size} seedBase={wordIndex} sweepDelay={wordIndex * 0.07} snap={snap} visible={dusting} />
                ) : null}
              </Animated.View>

              {/* The note, scribbled beside the word, a little low and level (owner, 2026-11-07). */}
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: (size?.width ?? 0) + NOTE_GAP,
                  top: (size?.height ?? 0) * 0.46,
                }}
              >
                <Animated.View style={{ overflow: dusting ? 'visible' : 'hidden', transform: [{ translateX: write }], opacity: reducedMotion ? inOpacity : 1 }}>
                  <Animated.View style={{ transform: [{ translateX: Animated.multiply(write, -1) }] }}>
                    <Text
                      maxFontSizeMultiplier={DECORATIVE_SCALE}
                      numberOfLines={1}
                      style={[noteStyle, { opacity: dusting ? 0 : 1 }]}
                      onLayout={(event) => {
                        const { width, height } = event.nativeEvent.layout;
                        setNoteSizes((current) => withSize(current, wordIndex, width, height));
                      }}
                    >
                      {word.note}
                    </Text>
                    {noteSize && !reducedMotion && !dustGone && wordIndex < dustBuilt ? (
                      <WordDust content={word.note} style={noteStyle} size={noteSize} seedBase={wordIndex + 10} sweepDelay={0.18 + wordIndex * 0.07} snap={snap} visible={dusting} />
                    ) : null}
                  </Animated.View>
                </Animated.View>
              </View>
            </View>
          );
        })}
      </View>
      ) : null}

      {/* The note from the team, over the page once the words have gone. */}
      {fontReady || fontWaitOver ? (
        <View
          pointerEvents={showingLetter ? 'box-none' : 'none'}
          accessibilityElementsHidden={!showingLetter}
          importantForAccessibility={showingLetter ? 'auto' : 'no-hide-descendants'}
          style={[StyleSheet.absoluteFill, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
        >
          {/* Scrolls only when Dynamic Type makes the note taller than the room. */}
          <ScrollView
            accessible
            accessibilityLabel={`${LETTER.headline}. ${LETTER.bodyBefore}Magicbooklet${LETTER.bodyAfter} ${LETTER.signature.replace('—', '').trim()}.`}
            style={{ flex: 1 }}
            contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingHorizontal: 32, paddingVertical: 28 }}
            showsVerticalScrollIndicator={false}
            // The default written out: nothing on this page opens a keyboard.
            keyboardShouldPersistTaps="never"
          >
            <Animated.Text maxFontSizeMultiplier={appTheme.typeScale.title} style={[{ fontFamily: DISPLAY_FONT.extraBold, fontWeight: '400', fontSize: 30, lineHeight: 36, letterSpacing: -0.4, color: page.colors.text }, letterPart(LETTER_HEAD, 12)]}>
              {LETTER.headline}
            </Animated.Text>
            <Animated.Text maxFontSizeMultiplier={appTheme.typeScale.body} style={[{ marginTop: 18, maxWidth: 360, fontSize: 17, lineHeight: 27, color: page.colors.textSecondary }, letterPart(LETTER_BODY, 10)]}>
              {LETTER.bodyBefore}
              {/* The name in the logo's two colours: the coral of its spark,
                  the lavender of its pages (owner, 2026-11-07), spelled as the
                  app spells it everywhere (__tests__/hig-branding.test.ts). */}
              <Text style={{ fontWeight: '700', color: page.colors.primary }}>Magic</Text>
              <Text style={{ fontWeight: '700', color: page.colors.motion }}>booklet</Text>
              {LETTER.bodyAfter}
            </Animated.Text>
            <View style={{ marginTop: 22, alignSelf: 'flex-start' }}>
              <Animated.View style={{ overflow: 'hidden', transform: [{ translateX: signWrite }], opacity: reducedMotion ? letter : 1 }}>
                <Animated.View style={{ transform: [{ translateX: Animated.multiply(signWrite, -1) }] }}>
                  <Text
                    maxFontSizeMultiplier={DECORATIVE_SCALE}
                    numberOfLines={1}
                    // Room on the right for the handwriting's slant: the last
                    // letter leans past the text's measured box, and the
                    // writing window clips at that box.
                    style={[SIGN_STYLE, { color: page.colors.primary, paddingRight: 8 }]}
                    onLayout={(event) => {
                      const { width } = event.nativeEvent.layout;
                      setSignWidth((current) => (Math.abs(current - width) < 0.5 ? current : width));
                    }}
                  >
                    {/* In the logo's two colours, as the name in the paragraph is. */}
                    — Magic<Text style={{ color: page.colors.motion }}>booklet</Text>
                  </Text>
                </Animated.View>
              </Animated.View>
            </View>
          </ScrollView>

          <Animated.View
            pointerEvents={letterRead && phase === 'letter' ? 'auto' : 'none'}
            style={[{ paddingHorizontal: 24, paddingBottom: 16 }, letterPart(LETTER_ACTION, 8)]}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={LETTER.action}
              onPress={leave}
              style={({ pressed }) => ({
                minHeight: appTheme.touch.roomy,
                borderRadius: appTheme.radii.pill,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: pressed ? page.colors.primaryFillPressed : page.colors.primaryFill,
              })}
            >
              <Text maxFontSizeMultiplier={appTheme.typeScale.control} style={{ fontFamily: DISPLAY_FONT.bold, fontWeight: '400', fontSize: 17, color: page.colors.onPrimary }}>{LETTER.action}</Text>
            </Pressable>
          </Animated.View>
        </View>
      ) : null}
      </Animated.View>
    </Animated.View>
  );
}

function WordDust({
  content,
  style,
  size,
  seedBase,
  sweepDelay,
  snap,
  visible,
}: {
  content: ReactNode;
  style: TextStyle;
  size: Size;
  seedBase: number;
  /** Where in the snap this piece starts to go (0 to 1). */
  sweepDelay: number;
  snap: Animated.Value;
  /** Mounted early (during the arrival) so the swap at the snap costs no frame. */
  visible: boolean;
}) {
  const tiles = useMemo(() => {
    const cols = Math.ceil(size.width / TILE);
    const rows = Math.ceil(size.height / TILE);
    const list = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const seed = seedBase * 10000 + row * 100 + col;
        const a = scatter(seed);
        const b = scatter(seed + 0.5);
        const c = scatter(seed + 0.25);
        // A sweep from the left of each word, the lower words a beat later,
        // with scatter so the edge of the dust is ragged.
        const sweep = col / cols;
        const begin = Math.min(0.62, 0.02 + sweepDelay + sweep * 0.42 + a * 0.12);
        const span = 0.3 + b * 0.12;
        list.push({
          key: `${row}-${col}`,
          x: col * TILE,
          y: row * TILE,
          begin,
          end: Math.min(1, begin + span),
          // Squared, so most grains settle close by and a few are carried far.
          driftX: 30 + a * a * 220,
          driftY: -(18 + b * b * 170),
          spin: (c - 0.5) * 260,
        });
      }
    }
    return list;
  }, [seedBase, size.height, size.width, sweepDelay]);

  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: visible ? 1 : 0 }]}>
      {tiles.map((tile) => {
        const t = snap.interpolate({ inputRange: [tile.begin, tile.end], outputRange: [0, 1], extrapolate: 'clamp' });
        return (
          <Animated.View
            key={tile.key}
            style={{
              position: 'absolute',
              left: tile.x,
              top: tile.y,
              width: TILE,
              height: TILE,
              overflow: 'hidden',
              // Dims early, so a grain reads as ash rather than a piece of letter.
              opacity: t.interpolate({ inputRange: [0, 0.15, 0.6, 1], outputRange: [1, 0.8, 0.35, 0] }),
              transform: [
                // Slow to leave, quicker as the wind takes it: an ease-in curve
                // sampled at quarters so the speed builds without a visible kink
                // (a side-to-side sway was tried and read as a glitch, owner
                // 2026-11-07).
                { translateX: t.interpolate({ inputRange: EASE_STEPS, outputRange: EASE_IN.map((share) => share * tile.driftX) }) },
                { translateY: t.interpolate({ inputRange: EASE_STEPS, outputRange: EASE_IN_STEEP.map((share) => share * tile.driftY) }) },
                { rotate: t.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${tile.spin}deg`] }) },
                // Breaks down to a grain within the first third.
                { scale: t.interpolate({ inputRange: [0, 0.3, 1], outputRange: [1, 0.45, 0.15] }) },
              ],
            }}
          >
            <Text
              maxFontSizeMultiplier={DECORATIVE_SCALE}
              numberOfLines={1}
              style={[style, { position: 'absolute', left: -tile.x, top: -tile.y, width: size.width }]}
            >
              {content}
            </Text>
          </Animated.View>
        );
      })}
    </View>
  );
}
