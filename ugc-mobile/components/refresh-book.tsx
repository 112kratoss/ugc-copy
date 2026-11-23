import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Platform, RefreshControl, StyleSheet, View, type RefreshControlProps } from 'react-native';
import { Gesture, GestureDetector, type PanGesture } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  runOnUI,
  useAnimatedRef,
  useAnimatedStyle,
  useDerivedValue,
  useScrollOffset,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

import { useReducedMotion } from '@/lib/motion';
import {
  REFRESH_BOOK,
  REFRESH_BOOK_CHIP,
  REFRESH_BOOK_CYCLE_MS,
  REFRESH_BOOK_PAGES,
  androidPullDecision,
  androidPullDistance,
  androidPullRefreshes,
  androidSystemPullOffset,
  iosPulled,
  refreshBookChipTop,
  refreshBookHideDelayMs,
  refreshBookPageAngle,
  refreshBookPhase,
  refreshPullOffset,
  refreshPullProgress,
} from '@/lib/refresh-book';
import { useAppTheme } from '@/lib/theme-context';

// Screen suites mock react-native down to the primitives each screen draws, as
// the skeleton's do (`components/skeleton.tsx`): these two are read through a
// guard, so a screen's suite need not know the book is there.
function optionalNativeExport<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
const platformOS = () => optionalNativeExport(() => Platform.OS) ?? 'ios';
const hairline = () => optionalNativeExport(() => StyleSheet.hairlineWidth) ?? 0.5;

/**
 * A screen's pull to refresh with the refresh book (`lib/refresh-book.ts` says
 * how each platform's pull works). The screen gives the list's own scroll view
 * to `attachScroll`, wraps the list in `BookPullArea` with it, passes
 * `refreshControl` to the list, and draws `RefreshBookChip` over the list.
 */
export type BookPull = {
  /**
   * The list's own scroll view: a `ScrollView` itself, or a FlashList's or
   * FlatList's `getNativeScrollRef()`. Its offset tells the pull whether the
   * list is at its top, and on iOS how far it is pulled.
   */
  attachScroll: (scrollView: unknown) => void;
  offset: SharedValue<number>;
  /** Android: how far the app's own pull has the finger; 0 when none. */
  distance: SharedValue<number>;
  /** Android: set at a release that refreshes, until the screen says it is refreshing. */
  released: SharedValue<boolean>;
  /** Android: the pull's pan, for `BookPullArea`. */
  gesture: PanGesture | null;
  /**
   * The list's `refreshControl`. iOS: the platform's pull, while the pull is
   * on. Android: the platform's control, always there, for a drag that runs
   * on past the top (see `lib/refresh-book.ts`).
   */
  refreshControl: ReactElement<RefreshControlProps> | undefined;
};

export function useBookPull({
  refreshing,
  onRefresh,
  enabled = true,
  paused = false,
  contentTop = 0,
  androidRestTop,
}: {
  /** The screen's own pull state, as it gave `RefreshControl` before. */
  refreshing: boolean;
  onRefresh: () => void;
  /**
   * Off where the screen has nothing to refresh (signed out). On iOS this takes
   * the platform's control away, which builds the list's content again: only
   * for a state that lasts.
   */
  enabled?: boolean;
  /**
   * Held off for a moment (a card's pictures being swiped), with nothing in the
   * tree changed on either platform. Android's pull takes no new touch; iOS
   * needs nothing, since a list that cannot scroll cannot be pulled.
   */
  paused?: boolean;
  /** As given to `RefreshBookChip`: Android's own circle comes to rest where the book's does. */
  contentTop?: number;
  androidRestTop?: number;
}): BookPull {
  const os = platformOS();
  const theme = useAppTheme();
  const scrollRef = useAnimatedRef();
  const offset = useScrollOffset(scrollRef);
  const distance = useSharedValue(0);
  const released = useSharedValue(false);
  const refreshingNow = useSharedValue(refreshing);
  const takesPulls = enabled && !paused;
  const enabledNow = useSharedValue(takesPulls);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const decided = useSharedValue(false);

  const latest = useRef({ refreshing, onRefresh });
  useEffect(() => {
    latest.current = { refreshing, onRefresh };
  });
  // `released` holds the circle at rest from the release until the chip's own
  // hold has taken over, so it is let go only once the refresh is over.
  useEffect(() => {
    refreshingNow.value = refreshing;
    if (!refreshing) released.value = false;
  }, [refreshing, refreshingNow, released]);
  // Read by the pan, never by what is drawn: switching the pull off or on must
  // not change the tree around the list, or the list is built again from its top
  // (Explore pauses it for every swipe through a card's pictures).
  useEffect(() => {
    enabledNow.value = takesPulls;
  }, [takesPulls, enabledNow]);

  // Called from the pull's release on the UI thread, or by the platform's
  // control. A screen that turns the refresh down leaves the circle nothing to
  // wait for.
  const fireRefresh = useCallback(() => {
    if (latest.current.refreshing) return;
    // Android's own circle is at rest where the book's is: the book's is there at once, over it.
    if (os === 'android') released.value = true;
    latest.current.onRefresh();
    setTimeout(() => {
      if (!latest.current.refreshing) released.value = false;
    }, 400);
  }, [os, released]);

  const attachedScroll = useRef<unknown>(null);
  const attachScroll = useCallback(
    (scrollView: unknown) => {
      if (!scrollView || scrollView === attachedScroll.current) return;
      attachedScroll.current = scrollView;
      // A list built anew (each of Home's lanes is a list of its own) starts at
      // its top and says nothing until it scrolls: the offset the last list
      // left must not stand for it, or its first pull reads as not at the top.
      offset.value = 0;
      (scrollRef as unknown as (node: unknown) => void)(scrollView);
    },
    [offset, scrollRef],
  );

  const gesture = useMemo(() => {
    if (os !== 'android') return null;
    return Gesture.Pan()
      .manualActivation(true)
      .maxPointers(1)
      .onTouchesDown((event, manager) => {
        'worklet';
        if (!enabledNow.value) {
          // Nothing to refresh, or a card's pictures being swiped: the touch is the list's.
          decided.value = true;
          manager.fail();
          return;
        }
        const touch = event.allTouches[0];
        if (!touch) return;
        startX.value = touch.absoluteX;
        startY.value = touch.absoluteY;
        decided.value = false;
      })
      .onTouchesMove((event, manager) => {
        'worklet';
        if (decided.value) return;
        const touch = event.allTouches[0];
        if (!touch) return;
        const decision = androidPullDecision(
          touch.absoluteX - startX.value,
          touch.absoluteY - startY.value,
          offset.value <= 0.5 && !refreshingNow.value && enabledNow.value,
        );
        if (decision === 'pull') {
          decided.value = true;
          manager.activate();
        } else if (decision === 'pass') {
          decided.value = true;
          manager.fail();
        }
      })
      .onUpdate((event) => {
        'worklet';
        distance.value = androidPullDistance(event.translationY);
      })
      .onEnd((_event, success) => {
        'worklet';
        // A pull the system took back (a second finger, a call coming in) never refreshes.
        if (success && enabledNow.value && androidPullRefreshes(distance.value)) {
          released.value = true;
          runOnJS(fireRefresh)();
        }
        distance.value = withTiming(0, { duration: 240, easing: Easing.out(Easing.cubic) });
      })
      .onFinalize(() => {
        'worklet';
        if (distance.value > 0 && !released.value) {
          distance.value = withTiming(0, { duration: 200, easing: Easing.out(Easing.cubic) });
        }
      });
  }, [decided, distance, enabledNow, fireRefresh, offset, os, refreshingNow, released, startX, startY]);

  let refreshControl: ReactElement<RefreshControlProps> | undefined;
  if (os === 'android') {
    // Always given, switched off rather than taken away: a list wraps itself in
    // its control on Android, so taking it away builds the list again.
    refreshControl = (
      <RefreshControl
        // Never told: it lets go at release and the book takes its place.
        refreshing={false}
        onRefresh={fireRefresh}
        enabled={takesPulls && !refreshing}
        size="large"
        colors={[theme.colors.onPrimary]}
        progressBackgroundColor={theme.colors.primaryFill}
        progressViewOffset={androidSystemPullOffset(refreshBookChipTop('android', contentTop, androidRestTop))}
      />
    );
  } else if (enabled) {
    refreshControl = <BookRefreshControl refreshing={refreshing} onRefresh={fireRefresh} />;
  }

  return { attachScroll, offset, distance, released, gesture, refreshControl };
}

/**
 * The list, under the pull's pan on Android; as it is on iOS. The pan is there
 * whether or not the pull is on, so the list keeps its place in the tree.
 */
export function BookPullArea({ pull, children }: { pull: BookPull; children: ReactNode }) {
  if (!pull.gesture) return children;
  return (
    <GestureDetector gesture={pull.gesture}>
      <View style={{ flex: 1 }} collapsable={false}>
        {children}
      </View>
    </GestureDetector>
  );
}

/**
 * iOS's pull: the platform's own control, its spinner drawn clear so the book
 * is all that shows. Everything else passes through, including the `children`
 * and `style` a scroll view clones its control with.
 */
type BookRefreshControlProps = Omit<ComponentProps<typeof RefreshControl>, 'tintColor'>;

export function BookRefreshControl(props: BookRefreshControlProps) {
  return <RefreshControl {...props} tintColor="transparent" />;
}

const ENTER_MS = 220;
const EXIT_MS = 180;

/**
 * Up while `refreshing`, and for at least one page turn once up, so a refresh
 * answered at once does not flash the chip.
 */
function useHeldWhile(refreshing: boolean) {
  const [lingering, setLingering] = useState(false);
  const shownAt = useRef(0);

  useEffect(() => {
    if (refreshing) {
      shownAt.current = Date.now();
      return undefined;
    }
    if (shownAt.current === 0) return undefined;
    const delay = refreshBookHideDelayMs(shownAt.current, Date.now());
    shownAt.current = 0;
    if (delay === 0) return undefined;
    setLingering(true);
    const timer = setTimeout(() => setLingering(false), delay);
    return () => {
      clearTimeout(timer);
      setLingering(false);
    };
  }, [refreshing]);

  return refreshing || lingering;
}

/**
 * The coral circle with the book, centred at the top of the list. Its parent
 * must be the box the list fills (the circle is placed from that box's top).
 * Given the screen's `pull`, it comes down with the reader's pull; `top` pins
 * it for a refresh no pull started, such as a "New posts" tap, where it takes
 * the pill's place.
 */
export function RefreshBookChip({
  refreshing,
  pull,
  contentTop = 0,
  androidRestTop,
  top,
}: {
  refreshing: boolean;
  pull?: BookPull;
  contentTop?: number;
  /** Where Android's circle rests, clear of a first row of controls. */
  androidRestTop?: number;
  top?: number;
}) {
  const theme = useAppTheme();
  const reducedMotion = useReducedMotion();
  const os = platformOS();
  const held = useHeldWhile(refreshing);
  // The screen names `top` only while its refresh runs; the circle keeps that
  // place through its linger and exit, then goes back to waiting for a pull.
  const [lastTop, setLastTop] = useState(top);
  if (top !== undefined && top !== lastTop) setLastTop(top);
  // A refresh the screen names no place for (a pull) starting in that linger
  // is the pull's: the circle goes back to where a pull's rests.
  const [wasRefreshing, setWasRefreshing] = useState(refreshing);
  if (refreshing !== wasRefreshing) {
    setWasRefreshing(refreshing);
    if (refreshing && top === undefined && lastTop !== undefined) setLastTop(undefined);
  }
  const pinnedTop = top ?? lastTop;
  const hasPull = Boolean(pull);
  const pinned = pinnedTop !== undefined || !hasPull;
  // A pull's circle is always there to be pulled down; a pinned one comes and goes.
  const [mounted, setMounted] = useState(held || !pinned);
  const hold = useSharedValue(0);
  const turning = useSharedValue(false);
  const clock = useSharedValue(0);
  const fallbackDistance = useSharedValue(0);
  const fallbackOffset = useSharedValue(0);
  const fallbackReleased = useSharedValue(false);
  const distance = pull?.distance ?? fallbackDistance;
  const offset = pull?.offset ?? fallbackOffset;
  const released = pull?.released ?? fallbackReleased;

  useEffect(() => {
    if (held || !pinned) {
      setMounted(true);
      return undefined;
    }
    // Stay through the exit, then leave, or under a pull, wait for the next one.
    // (`hasPull`, not `pull`: the screen's pull is a new object every render, and
    // a screen that renders through the exit would put it off for good.)
    const timer = setTimeout(() => {
      if (hasPull && top === undefined) setLastTop(undefined);
      else setMounted(false);
    }, EXIT_MS);
    return () => clearTimeout(timer);
  }, [held, pinned, hasPull, top]);

  useEffect(() => {
    if (!mounted) return;
    hold.value = held
      ? withTiming(1, { duration: ENTER_MS, easing: Easing.out(Easing.cubic) })
      : withTiming(0, { duration: EXIT_MS, easing: Easing.in(Easing.quad) });
  }, [held, hold, mounted]);

  // The pages turn on a clock that only grows, from where the pull left the
  // top page, so a lifted page carries on over as the refresh begins.
  const animate = held && !reducedMotion;
  useEffect(() => {
    if (!animate) {
      turning.value = false;
      cancelAnimation(clock);
      return undefined;
    }
    runOnUI(() => {
      'worklet';
      const pulled = os === 'android' ? distance.value : iosPulled(offset.value);
      const progress = released.value ? 1 : refreshPullProgress(os, pulled);
      const start = refreshBookPhase(false, 0, progress);
      clock.value = start;
      turning.value = true;
      // A long linear run stands in for a repeat, so the phase never jumps back.
      clock.value = withTiming(start + 1000, { duration: 1000 * REFRESH_BOOK_CYCLE_MS, easing: Easing.linear });
    })();
    return () => cancelAnimation(clock);
  }, [animate, clock, distance, offset, os, released, turning]);

  const phase = useDerivedValue(() => {
    if (reducedMotion) return 0;
    const pulled = os === 'android' ? distance.value : iosPulled(offset.value);
    return refreshBookPhase(turning.value, clock.value, pinned ? 0 : refreshPullProgress(os, pulled));
  });

  const chipStyle = useAnimatedStyle(() => {
    const holding = Math.max(hold.value, released.value ? 1 : 0);
    if (pinned) {
      return {
        opacity: hold.value,
        transform: [{ translateY: (1 - hold.value) * -8 }, { scale: 0.72 + 0.28 * hold.value }],
      };
    }
    if (os === 'android') {
      const pulled = distance.value;
      const progress = refreshPullProgress('android', pulled);
      return {
        opacity: Math.max(Math.min(1, progress * 2.5), holding),
        transform: [
          // Down with the finger, then held at rest while the refresh runs.
          { translateY: refreshPullOffset('android', pulled) * (1 - holding) },
          { scale: 0.6 + 0.4 * Math.max(progress, holding) },
        ],
      };
    }
    // iOS: carried by the content, pulled down with it and settled in the gap.
    const pulled = iosPulled(offset.value);
    const progress = refreshPullProgress('ios', pulled);
    return {
      opacity: Math.min(1, pulled / 40),
      transform: [{ translateY: refreshPullOffset('ios', pulled) }, { scale: 0.7 + 0.3 * Math.max(progress, hold.value) }],
    };
  });

  if (!mounted) return null;

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        position: 'absolute',
        top: pinnedTop ?? refreshBookChipTop(os, contentTop, androidRestTop),
        left: 0,
        right: 0,
        alignItems: 'center',
        zIndex: 10,
      }}
    >
      <Animated.View
        style={[
          {
            width: REFRESH_BOOK_CHIP.size,
            height: REFRESH_BOOK_CHIP.size,
            borderRadius: REFRESH_BOOK_CHIP.size / 2,
            // The Create button's coral and glow: on both schemes the circle
            // stands off the page and off whatever it floats over.
            backgroundColor: theme.colors.primaryFill,
            boxShadow: theme.shadow.navigationCreate.boxShadow,
            alignItems: 'center',
            justifyContent: 'center',
          },
          chipStyle,
        ]}
      >
        <PageFlipBook phase={phase} />
      </Animated.View>
    </View>
  );
}

// The book's drawing, in points inside its `REFRESH_BOOK` box: a coral cover a
// shade deeper than the circle, its edges bowed like a book lying open, with a
// page block on each side of the spine.
const COVER_PATH = 'M0 1.5 Q7.5 0 15 2 Q22.5 0 30 1.5 L30 21 Q22.5 19.5 15 21 Q7.5 19.5 0 21 Z';
const PAGE_INSET_Y = 2;
const PAGE_INSET_X = 1.5;
const SPINE_X = REFRESH_BOOK.width / 2;
const PAGE_WIDTH = SPINE_X - PAGE_INSET_X;
const PAGE_HEIGHT = REFRESH_BOOK.height - PAGE_INSET_Y * 2;
// Ruled lines, inset the same on both sides so a page looks the same turned over.
const LINE_TOPS = [4.5, 8.5, 12.5];
const LINE_INSET = 2.5;
const PERSPECTIVE = 80;

/** The book alone, its pages where `phase` puts them (`refreshBookPhase`). */
export function PageFlipBook({ phase }: { phase: SharedValue<number> }) {
  const theme = useAppTheme();
  const pageColors = { paper: theme.colors.paper, line: theme.colors.paperLine };
  const turnOrder = Array.from({ length: REFRESH_BOOK_PAGES }, (_, order) => order);

  return (
    <View style={{ width: REFRESH_BOOK.width, height: REFRESH_BOOK.height }}>
      <Svg
        width={REFRESH_BOOK.width}
        height={REFRESH_BOOK.height}
        viewBox={`0 0 ${REFRESH_BOOK.width} ${REFRESH_BOOK.height}`}
        style={{ position: 'absolute', top: 0, left: 0 }}
      >
        <Path d={COVER_PATH} fill={theme.colors.bookCover} />
      </Svg>
      <Page side="left" colors={pageColors} />
      <Page side="right" colors={pageColors} />
      {/*
        Each turning page is drawn twice, once in each half's stack, because
        views do not sort by depth: on the right the first page to turn lies on
        top, and on the left the last page to land does. A copy shows only while
        its page is over its own half.
      */}
      {[...turnOrder].reverse().map((order) => (
        <TurningPage key={`right-${order}`} order={order} phase={phase} half="right" colors={pageColors} />
      ))}
      {turnOrder.map((order) => (
        <TurningPage key={`left-${order}`} order={order} phase={phase} half="left" colors={pageColors} />
      ))}
      <View
        style={{
          position: 'absolute',
          left: SPINE_X - hairline() / 2,
          top: PAGE_INSET_Y,
          width: hairline(),
          height: PAGE_HEIGHT,
          backgroundColor: theme.colors.paperLine,
        }}
      />
    </View>
  );
}

type PageColors = { paper: string; line: string };

function pageFrame(side: 'left' | 'right') {
  return {
    position: 'absolute' as const,
    top: PAGE_INSET_Y,
    left: side === 'left' ? PAGE_INSET_X : SPINE_X,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
  };
}

function PageLines({ color }: { color: string }) {
  return LINE_TOPS.map((top, index) => (
    <View
      key={top}
      style={{
        position: 'absolute',
        top,
        left: LINE_INSET,
        // The last line stops short, as a paragraph does.
        right: index === LINE_TOPS.length - 1 ? LINE_INSET + 4 : LINE_INSET,
        height: 1,
        backgroundColor: color,
      }}
    />
  ));
}

function Page({ side, colors }: { side: 'left' | 'right'; colors: PageColors }) {
  return (
    <View
      style={{
        ...pageFrame(side),
        backgroundColor: colors.paper,
        borderWidth: hairline(),
        borderColor: colors.line,
      }}
    >
      <PageLines color={colors.line} />
    </View>
  );
}

function TurningPage({
  order,
  phase,
  half,
  colors,
}: {
  order: number;
  phase: SharedValue<number>;
  half: 'left' | 'right';
  colors: PageColors;
}) {
  const style = useAnimatedStyle(() => {
    const angle = refreshBookPageAngle(phase.value, order);
    const overLeft = angle <= -90;
    return {
      opacity: (half === 'left') === overLeft ? 1 : 0,
      transform: [{ perspective: PERSPECTIVE }, { rotateY: `${angle}deg` }],
    };
  });
  // A page in the air catches less light, deepest standing on its edge: without
  // it a white page turning over white pages barely reads.
  const shade = useAnimatedStyle(() => ({
    opacity: Math.abs(Math.sin((refreshBookPageAngle(phase.value, order) * Math.PI) / 180)),
  }));

  return (
    <Animated.View
      style={[
        {
          ...pageFrame('right'),
          // Turns about the spine, its left edge.
          transformOrigin: 'left center',
          backgroundColor: colors.paper,
          borderWidth: hairline(),
          borderColor: colors.line,
        },
        style,
      ]}
    >
      <PageLines color={colors.line} />
      <Animated.View
        style={[
          { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.line },
          shade,
        ]}
      />
    </Animated.View>
  );
}
