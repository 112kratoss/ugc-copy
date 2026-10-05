import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

/**
 * The drag contract every sheet shares, exercised through the responder
 * callbacks it hands to React Native. The double returns the responder
 * config as its `panHandlers`, so a test can drive a gesture by hand.
 */
const animatedState = vi.hoisted(() => ({
  spring: vi.fn(() => ({ start: vi.fn() })),
}));

vi.mock('react-native', () => ({
  Animated: {
    View: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('view', props, children),
    Value: class {
      value: number;
      setValue = vi.fn((next: number) => {
        this.value = next;
      });

      constructor(initial: number) {
        this.value = initial;
      }

      interpolate(config: unknown) {
        return { interpolate: config };
      }
    },
    spring: animatedState.spring,
    timing: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
    add: (a: unknown, b: unknown) => ({ add: [a, b] }),
    multiply: (a: unknown, b: unknown) => ({ multiply: [a, b] }),
  },
  Easing: { in: (fn: unknown) => fn, out: (fn: unknown) => fn, cubic: 'cubic' },
  PanResponder: { create: (config: Record<string, unknown>) => ({ panHandlers: config }) },
  Pressable: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('pressable', props, children),
  View: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('view', props, children),
}));

import { Animated } from 'react-native';

import { SHEET_BACKDROP_FADE_DISTANCE, SheetBackdrop, sheetMotion, useSheetDismissDrag, useSheetPresentation, type SheetDismissDrag } from '../components/sheet-chrome';
import { leaveTouchToNativeView } from '../lib/native-touch-owner';

type Handler = (event: unknown, gesture: Record<string, number>) => unknown;
type Handlers = Record<string, Handler>;
type MockValue = { value: number; setValue: ReturnType<typeof vi.fn> };

function mount(visible: boolean, onDismiss = vi.fn(), takesTouchDown?: boolean) {
  let latest: SheetDismissDrag | undefined;
  const Probe = ({ shown }: { shown: boolean }) => {
    latest = useSheetDismissDrag({ onDismiss, visible: shown, takesTouchDown });
    return null;
  };
  let tree: renderer.ReactTestRenderer | undefined;
  renderer.act(() => {
    tree = renderer.create(<Probe shown={visible} />);
  });

  const drag = () => latest!;
  return {
    onDismiss,
    drag,
    grabber: () => drag().panHandlers as unknown as Handlers,
    content: () => drag().contentPanHandlers as unknown as Handlers,
    offset: () => drag().translateY as unknown as MockValue,
    show: (shown: boolean) => renderer.act(() => tree!.update(<Probe shown={shown} />)),
    unmount: () => renderer.act(() => tree!.unmount()),
  };
}

const gesture = (dy: number, dx = 0, vy = 0) => ({ dy, dx, vy, vx: 0 });

/** One event of a touch: each names the view that was under the finger when it came down. */
const PLAYER = 41;
const TITLE = 57;
const touchOn = (target: number) => ({ nativeEvent: { target, pageX: 120, pageY: 300 }, stopPropagation: () => {} });

describe('sheet dismiss drag', () => {
  it('starts every opening from rest, even after a drag dismissed the last one', () => {
    const sheet = mount(true);

    sheet.grabber().onPanResponderGrant({}, gesture(0));
    sheet.grabber().onPanResponderMove({}, gesture(140));
    expect(sheet.offset().value).toBe(140);

    sheet.grabber().onPanResponderRelease({}, gesture(140));
    expect(sheet.onDismiss).toHaveBeenCalledOnce();
    // The exit plays from where the finger let go: nothing resets it yet.
    expect(sheet.offset().value).toBe(140);

    sheet.show(false);
    sheet.show(true);
    // This is the bug: the create menu and the Showcase feedback sheet stayed
    // mounted while closed, never told the drag they were back, and reopened
    // 140pt down the screen.
    expect(sheet.offset().value).toBe(0);
    sheet.unmount();
  });

  it('dismisses on a long pull or a flick, and springs back from anything less', () => {
    const sheet = mount(true);

    sheet.grabber().onPanResponderGrant({}, gesture(0));
    sheet.grabber().onPanResponderRelease({}, gesture(40));
    expect(sheet.onDismiss).not.toHaveBeenCalled();
    expect(animatedState.spring).toHaveBeenCalledWith(sheet.offset(), expect.objectContaining({ toValue: 0 }));

    sheet.grabber().onPanResponderRelease({}, gesture(40, 0, 0.9));
    expect(sheet.onDismiss).toHaveBeenCalledOnce();

    sheet.grabber().onPanResponderRelease({}, gesture(101));
    expect(sheet.onDismiss).toHaveBeenCalledTimes(2);
    sheet.unmount();
  });

  it('lets the panel take only a downward drag, and only while its list is at the top', () => {
    const sheet = mount(true);
    const content = sheet.content();

    expect(content.onMoveShouldSetPanResponderCapture({}, gesture(20, 2))).toBe(true);
    // Still ambiguous with a scroll, or clearly sideways, or upward.
    expect(content.onMoveShouldSetPanResponderCapture({}, gesture(4))).toBe(false);
    expect(content.onMoveShouldSetPanResponderCapture({}, gesture(20, 40))).toBe(false);
    expect(content.onMoveShouldSetPanResponderCapture({}, gesture(-20))).toBe(false);

    // Scrolled into the list, a downward pull is the list's to scroll back.
    sheet.drag().scrollProps.onScroll!({ nativeEvent: { contentOffset: { y: 120 } } } as never);
    expect(content.onMoveShouldSetPanResponderCapture({}, gesture(20))).toBe(false);
    sheet.drag().scrollProps.onScroll!({ nativeEvent: { contentOffset: { y: 0 } } } as never);
    expect(content.onMoveShouldSetPanResponderCapture({}, gesture(20))).toBe(true);
    sheet.unmount();
  });

  // A player's own controls. Taken by the panel, Android cancels the touch under
  // it at the finger's first movement: in the Reference details sheet a finger
  // on play did nothing, and a tap with no movement played (S24, 2026-10-05).
  it('leaves a touch-down that a native view inside it has said is its own', () => {
    const sheet = mount(true);
    const content = sheet.content();
    const onThePlayer = touchOn(PLAYER);
    // The player's view is asked first, and declines for itself as it says so.
    expect(leaveTouchToNativeView(onThePlayer as never)).toBe(false);
    expect(content.onStartShouldSetPanResponder(onThePlayer, gesture(0))).toBe(false);
    // Only that view's: a touch on a title is the panel's.
    expect(content.onStartShouldSetPanResponder(touchOn(TITLE), gesture(0))).toBe(true);
    // The grabber is no part of the content, and still takes its own.
    expect(sheet.grabber().onStartShouldSetPanResponder(onThePlayer, gesture(0))).toBe(true);
    sheet.unmount();
  });

  // Nothing holds a player's touch (a holder would never hear a touch on the
  // seek bar end, and the next press in the sheet would be lost), so the panel
  // is asked about it at every move. A finger that slides down on the play
  // button as it presses is not a pull on the sheet: with only the start
  // question stopped, that press did not play 5 times in 6 (emulator, 2026-10-05).
  it('leaves that touch at every later move too, however far down it has gone', () => {
    const sheet = mount(true);
    const content = sheet.content();
    leaveTouchToNativeView(touchOn(PLAYER) as never);

    const sliding = touchOn(PLAYER);
    expect(content.onMoveShouldSetPanResponderCapture(sliding, gesture(20, 2))).toBe(false);
    expect(content.onMoveShouldSetPanResponder(sliding, gesture(20, 2))).toBe(false);
    expect(content.onMoveShouldSetPanResponderCapture(sliding, gesture(180))).toBe(false);

    // The same pull from a title, or from a button the finger is already on, is the sheet's.
    const onATitle = touchOn(TITLE);
    expect(content.onMoveShouldSetPanResponderCapture(onATitle, gesture(20, 2))).toBe(true);
    expect(content.onMoveShouldSetPanResponder(onATitle, gesture(20, 2))).toBe(true);
    sheet.unmount();
  });

  it('takes an unowned touch on touch-down but moves nothing until it is a pull', () => {
    // Inside a Modal on Android a view that declines the start phase is never
    // offered the move phase, so a pull that begins on a title or a gap has
    // to be taken at once — and then held still until it proves itself.
    const sheet = mount(true);
    const content = sheet.content();
    expect(content.onStartShouldSetPanResponder({}, gesture(0))).toBe(true);
    // The opening itself resets the offset; only the gesture is under test.
    sheet.offset().setValue.mockClear();

    content.onPanResponderGrant({}, gesture(0));
    // While unarmed a list underneath may take the touch away to scroll.
    expect(content.onPanResponderTerminationRequest({}, gesture(0))).toBe(true);
    content.onPanResponderMove({}, gesture(-30));
    content.onPanResponderMove({}, gesture(4));
    expect(sheet.offset().setValue).not.toHaveBeenCalled();
    // A release that never armed is a tap on a title: nothing happens.
    animatedState.spring.mockClear();
    content.onPanResponderRelease({}, gesture(4));
    expect(sheet.onDismiss).not.toHaveBeenCalled();
    expect(animatedState.spring).not.toHaveBeenCalled();

    // Past the claim distance the touch arms, from where it is — no jump.
    content.onPanResponderGrant({}, gesture(0));
    content.onPanResponderMove({}, gesture(10));
    expect(sheet.offset().value).toBe(0);
    expect(content.onPanResponderTerminationRequest({}, gesture(10))).toBe(false);
    content.onPanResponderMove({}, gesture(60));
    expect(sheet.offset().value).toBe(50);
    content.onPanResponderRelease({}, gesture(160));
    expect(sheet.onDismiss).toHaveBeenCalledOnce();
    sheet.unmount();
  });

  it('takes no touch-down for a sheet that asks it not to, and still takes the pull', () => {
    // In the app's own window nothing above the panel takes an unowned touch,
    // so the panel can wait for the pull. Held from its start, the touch is
    // lost to a scroll view inside the panel on Android.
    const sheet = mount(true, vi.fn(), false);
    const content = sheet.content();

    expect(content.onStartShouldSetPanResponder(touchOn(TITLE), gesture(0))).toBe(false);
    // The grabber is its own strip and still takes its touch as it lands.
    expect(sheet.grabber().onStartShouldSetPanResponder(touchOn(TITLE), gesture(0))).toBe(true);

    // The pull is taken at the move, and arrives armed: the sheet follows from where it was taken.
    expect(content.onMoveShouldSetPanResponder(touchOn(TITLE), gesture(8))).toBe(true);
    content.onPanResponderGrant({}, gesture(8));
    content.onPanResponderMove({}, gesture(60));
    expect(sheet.offset().value).toBe(52);
    content.onPanResponderRelease({}, gesture(160));
    expect(sheet.onDismiss).toHaveBeenCalledOnce();
    sheet.unmount();
  });

  it('never arms over a list that is scrolled away from its top', () => {
    const sheet = mount(true);
    const content = sheet.content();
    sheet.drag().scrollProps.onScroll!({ nativeEvent: { contentOffset: { y: 80 } } } as never);
    sheet.offset().setValue.mockClear();

    content.onPanResponderGrant({}, gesture(0));
    content.onPanResponderMove({}, gesture(90));
    expect(sheet.offset().setValue).not.toHaveBeenCalled();
    content.onPanResponderRelease({}, gesture(200, 0, 2));
    expect(sheet.onDismiss).not.toHaveBeenCalled();

    // Once the list reaches its top mid-gesture, the sheet follows: the
    // hand-off every system sheet makes.
    sheet.drag().scrollProps.onScroll!({ nativeEvent: { contentOffset: { y: 0 } } } as never);
    content.onPanResponderMove({}, gesture(120));
    content.onPanResponderMove({}, gesture(150));
    expect(sheet.offset().value).toBe(30);
    sheet.unmount();
  });

  it('takes a pull on the grabber wherever the list is scrolled to', () => {
    // The grabber's handlers are also what a sheet spreads on a header that
    // must answer a pull while its body is scrolled.
    const sheet = mount(true);
    sheet.drag().scrollProps.onScroll!({ nativeEvent: { contentOffset: { y: 80 } } } as never);
    const grabber = sheet.grabber();

    expect(grabber.onStartShouldSetPanResponder(touchOn(TITLE), gesture(0))).toBe(true);
    expect(grabber.onMoveShouldSetPanResponder(touchOn(TITLE), gesture(20))).toBe(true);
    grabber.onPanResponderGrant({}, gesture(0));
    grabber.onPanResponderMove({}, gesture(60));
    expect(sheet.offset().value).toBe(60);
    grabber.onPanResponderRelease({}, gesture(140));
    expect(sheet.onDismiss).toHaveBeenCalledOnce();
    sheet.unmount();
  });

  it('forgets the old scroll position when the sheet is shown again', () => {
    const sheet = mount(true);
    sheet.drag().scrollProps.onScroll!({ nativeEvent: { contentOffset: { y: 300 } } } as never);
    sheet.show(false);
    sheet.show(true);
    // A Modal remounts its list at the top; the drag has to know that too.
    expect(sheet.content().onMoveShouldSetPanResponderCapture({}, gesture(20))).toBe(true);
    sheet.unmount();
  });

  it('does not jump when the panel takes a touch that has already moved', () => {
    const sheet = mount(true);
    sheet.content().onPanResponderGrant({}, gesture(8));
    sheet.content().onPanResponderMove({}, gesture(30));
    expect(sheet.offset().value).toBe(22);
    // Dismissal distance is measured from where the sheet took over, too.
    sheet.content().onPanResponderRelease({}, gesture(105));
    expect(sheet.onDismiss).not.toHaveBeenCalled();
    sheet.content().onPanResponderRelease({}, gesture(109));
    expect(sheet.onDismiss).toHaveBeenCalledOnce();
    sheet.unmount();
  });

  it('springs back when the host answers a dismissal without closing', async () => {
    // The resource editor asks about unsaved changes instead of closing.
    const sheet = mount(true);
    animatedState.spring.mockClear();
    sheet.grabber().onPanResponderGrant({}, gesture(0));
    sheet.grabber().onPanResponderMove({}, gesture(140));
    sheet.grabber().onPanResponderRelease({}, gesture(140));
    expect(sheet.onDismiss).toHaveBeenCalledOnce();
    expect(animatedState.spring).not.toHaveBeenCalled();

    await renderer.act(() => new Promise((resolve) => setTimeout(resolve, 5)));
    expect(animatedState.spring).toHaveBeenCalledWith(sheet.offset(), expect.objectContaining({ toValue: 0 }));
    sheet.unmount();
  });

  it('leaves a sheet the host did close where the finger let go', async () => {
    const sheet = mount(true);
    animatedState.spring.mockClear();
    sheet.grabber().onPanResponderGrant({}, gesture(0));
    sheet.grabber().onPanResponderRelease({}, gesture(140));
    sheet.show(false);

    await renderer.act(() => new Promise((resolve) => setTimeout(resolve, 5)));
    expect(animatedState.spring).not.toHaveBeenCalled();
    sheet.unmount();
  });

  it('fades the scrim across the pull', () => {
    const sheet = mount(true);
    expect(sheet.drag().backdropOpacity).toEqual({
      interpolate: { inputRange: [0, SHEET_BACKDROP_FADE_DISTANCE], outputRange: [1, 0], extrapolate: 'clamp' },
    });
    expect(sheet.drag().backdropStyle).toEqual({ opacity: sheet.drag().backdropOpacity });
    expect(sheet.drag().scrollProps).toMatchObject({ bounces: false, overScrollMode: 'never', scrollEventThrottle: 16 });
    sheet.unmount();
  });
});

describe('a hosted sheet’s motion', () => {
  function mountHosted() {
    let latest: { drag: SheetDismissDrag; presentation: ReturnType<typeof useSheetPresentation> } | undefined;
    const Probe = () => {
      const drag = useSheetDismissDrag({ onDismiss: () => {}, visible: true });
      const presentation = useSheetPresentation({ visible: true, reducedMotion: false });
      latest = { drag, presentation };
      return null;
    };
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<Probe />);
    });
    return { ...latest!, unmount: () => renderer.act(() => tree!.unmount()) };
  }

  it('folds the entrance and the drag into one transform and one opacity', () => {
    const { drag, presentation, unmount } = mountHosted();
    const motion = sheetMotion(drag, presentation);

    // Two transforms, or two opacities, on one view would not compose: one is
    // driven natively by the timing, the other set from the finger.
    expect(motion.panel).toEqual({
      opacity: presentation.panelOpacity,
      transform: [{ translateY: { add: [presentation.entryTranslateY, drag.translateY] } }],
    });
    expect(motion.backdrop).toEqual({
      opacity: { multiply: [presentation.backdropProgress, drag.backdropOpacity] },
    });
    unmount();
  });

  it('gives the scrim that one opacity in place of the drag’s own', () => {
    const { drag, presentation, unmount } = mountHosted();
    const motion = sheetMotion(drag, presentation);
    const scrimStyle = (element: React.ReactElement) => {
      let tree: renderer.ReactTestRenderer | undefined;
      renderer.act(() => {
        tree = renderer.create(element);
      });
      const style = tree!.root.findAllByType('view' as never)[0].props.style as unknown[];
      renderer.act(() => tree!.unmount());
      return style[style.length - 1];
    };

    expect(scrimStyle(<SheetBackdrop drag={drag} onPress={() => {}} />)).toEqual(drag.backdropStyle);
    expect(scrimStyle(<SheetBackdrop drag={drag} style={motion.backdrop} onPress={() => {}} />)).toEqual(motion.backdrop);
    unmount();
  });
});

describe('a hosted sheet’s arrival and departure', () => {
  function mountPresented(reducedMotion = false) {
    const onEntered = vi.fn();
    const onExited = vi.fn();
    let latest: ReturnType<typeof useSheetPresentation> | undefined;
    const Probe = ({ shown }: { shown: boolean }) => {
      latest = useSheetPresentation({ visible: shown, reducedMotion, onEntered, onExited });
      return null;
    };
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<Probe shown={false} />);
    });
    return {
      onEntered,
      onExited,
      show: (shown: boolean) => renderer.act(() => tree!.update(<Probe shown={shown} />)),
      /** The panel's first layout, which the slide waits for: it travels the panel's own height. */
      measure: () => renderer.act(() => latest!.onPanelLayout({ nativeEvent: { layout: { height: 560 } } } as never)),
      unmount: () => renderer.act(() => tree!.unmount()),
    };
  }

  /** Ends the newest timed animation, as the native side does once it has run (or been cut short). */
  function endSlide(finished = true) {
    const started = vi.mocked(Animated.timing).mock.results;
    const slide = started[started.length - 1].value as unknown as { start: ReturnType<typeof vi.fn> };
    const calls = slide.start.mock.calls;
    renderer.act(() => (calls[calls.length - 1][0] as (result: { finished: boolean }) => void)({ finished }));
  }

  // The sheet a reference tile opens holds its clip's player back until this
  // is said: a player built while the sheet travelled took the first 32 to
  // 197 ms out of the slide (emulator and simulator films, 2026-10-05).
  it('says the sheet has arrived once its slide has played, and not before', () => {
    const sheet = mountPresented();
    sheet.show(true);
    expect(sheet.onEntered).not.toHaveBeenCalled();
    sheet.measure();
    // On its way in.
    expect(sheet.onEntered).not.toHaveBeenCalled();
    endSlide();
    expect(sheet.onEntered).toHaveBeenCalledTimes(1);
    expect(sheet.onExited).not.toHaveBeenCalled();
    sheet.unmount();
  });

  it('does not say so for a slide that was cut short', () => {
    const sheet = mountPresented();
    sheet.show(true);
    sheet.measure();
    endSlide(false);
    expect(sheet.onEntered).not.toHaveBeenCalled();
    sheet.unmount();
  });

  it('says it at once when there is no slide to wait for', () => {
    const slidesBefore = vi.mocked(Animated.timing).mock.calls.length;
    const sheet = mountPresented(true);
    sheet.show(true);
    sheet.measure();
    expect(sheet.onEntered).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Animated.timing).mock.calls.length).toBe(slidesBefore);
    sheet.unmount();
  });

  it('says it has left when its exit has played, and nothing more of its arrival', () => {
    const sheet = mountPresented();
    sheet.show(true);
    sheet.measure();
    endSlide();
    sheet.show(false);
    expect(sheet.onExited).not.toHaveBeenCalled();
    endSlide();
    expect(sheet.onExited).toHaveBeenCalledTimes(1);
    expect(sheet.onEntered).toHaveBeenCalledTimes(1);
    sheet.unmount();
  });
});
