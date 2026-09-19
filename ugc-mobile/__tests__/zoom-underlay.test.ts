import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios' }));

vi.mock('react-native', () => ({ Platform: platform }));
vi.mock('react-native-reanimated', () => ({
  makeMutable: <T,>(initial: T) => {
    let value = initial;
    return {
      get value() {
        return value;
      },
      set value(next: T) {
        value = next;
      },
      get: () => value,
      set: (next: T) => {
        value = next;
      },
    };
  },
}));

const source = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

describe('the screen under an open reel', () => {
  beforeEach(() => {
    vi.resetModules();
    platform.OS = 'android';
  });

  it('is hidden on Android and shown again', async () => {
    const underlay = await import('@/lib/zoom-underlay');
    expect(underlay.zoomUnderlayHidden.get()).toBe(0);
    underlay.setZoomUnderlayHidden(true);
    expect(underlay.zoomUnderlayHidden.get()).toBe(1);
    underlay.setZoomUnderlayHidden(false);
    expect(underlay.zoomUnderlayHidden.get()).toBe(0);
  });

  it('is left alone on iOS, where the stack has its own pop gesture', async () => {
    platform.OS = 'ios';
    const underlay = await import('@/lib/zoom-underlay');
    underlay.setZoomUnderlayHidden(true);
    expect(underlay.zoomUnderlayHidden.get()).toBe(0);
  });

  it('is hidden once the reel is uncovered, and back for a close, an exit and an unmount', () => {
    const zoom = source('components/media-zoom.tsx');
    const finishOpen = zoom.slice(zoom.indexOf('const finishOpen = useCallback'), zoom.indexOf('const handoff = useCallback'));
    expect(finishOpen).toContain('setZoomUnderlayHidden(true)');
    const dismiss = zoom.slice(zoom.indexOf('const dismiss = useCallback'), zoom.indexOf('handle.measure((rect) =>'));
    expect(dismiss).toContain('setZoomUnderlayHidden(false)');
    const leave = zoom.slice(zoom.indexOf('const leave = useCallback'), zoom.indexOf('const returnableVideo = useCallback'));
    expect(leave).toContain('setZoomUnderlayHidden(false)');
    expect(leave).toContain('useEffect(() => () => setZoomUnderlayHidden(false), [])');
    // A reel replaced or popped by any other navigation brings the screen back before it goes.
    expect(leave).toContain("navigation.addListener('beforeRemove', () => setZoomUnderlayHidden(false))");
    // With the flight's own values, so the screen beneath is drawn in the close's first moving frame.
    const flight = zoom.slice(zoom.indexOf('function startZoomFlight('), zoom.indexOf('function takeOffZoomFlight('));
    expect(flight).toContain("if (spec.direction === 'close') setZoomUnderlayHidden(false);");
  });

  it('is the tab screens, wrapped as one animated view', () => {
    const tabs = source('app/(tabs)/_layout.tsx');
    expect(tabs).toContain("import { zoomUnderlayHidden } from '@/lib/zoom-underlay'");
    // Only the tabs a reel covers: tabs pushed above a reel are focused and stay drawn.
    expect(tabs).toContain('opacity: 1 - zoomUnderlayHidden.value * covered.value');
    expect(tabs).toContain('useSharedValue(navigation.isFocused() ? 0 : 1)');
    expect(tabs).toContain("navigation.addListener('focus', () => covered.set(0))");
    expect(tabs).toContain("navigation.addListener('blur', () => covered.set(1))");
    expect(tabs.indexOf('<Animated.View style={[styles.fill, underlayStyle]}>')).toBeLessThan(tabs.indexOf('<Tabs'));
    expect(tabs.indexOf('</Tabs>')).toBeLessThan(tabs.indexOf('</Animated.View>'));
  });
});
