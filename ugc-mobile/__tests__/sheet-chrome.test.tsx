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
  },
  Easing: { in: (fn: unknown) => fn, out: (fn: unknown) => fn, cubic: 'cubic' },
  PanResponder: { create: (config: Record<string, unknown>) => ({ panHandlers: config }) },
  Pressable: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('pressable', props, children),
  View: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('view', props, children),
}));

import { SHEET_BACKDROP_FADE_DISTANCE, useSheetDismissDrag, type SheetDismissDrag } from '../components/sheet-chrome';

type Handler = (event: unknown, gesture: Record<string, number>) => unknown;
type Handlers = Record<string, Handler>;
type MockValue = { value: number; setValue: ReturnType<typeof vi.fn> };

function mount(visible: boolean, onDismiss = vi.fn()) {
  let latest: SheetDismissDrag | undefined;
  const Probe = ({ shown }: { shown: boolean }) => {
    latest = useSheetDismissDrag({ onDismiss, visible: shown });
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
