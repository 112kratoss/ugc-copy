import { readdirSync, readFileSync } from 'node:fs';
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

  // Out of layout under a resting reel (`display: 'none'`), the grid came back
  // from a second post's reel at the offset of the first: the store build's
  // scroll view clamps to its content as it turns visible, and the content's
  // native frame was still an earlier hide's (owner's S24, 2026-11-28).
  it('never leaves layout: hiding sets no timer and nothing but the opacity', async () => {
    vi.useFakeTimers();
    try {
      const underlay = await import('@/lib/zoom-underlay');
      underlay.setZoomUnderlayHidden(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(Object.keys(underlay).sort()).toEqual(['ZOOM_UNDERLAY_HIDES', 'setZoomUnderlayHidden', 'zoomUnderlayHidden']);
    } finally {
      vi.useRealTimers();
    }
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
    // And nothing else: no `display`, on this view or one of its own around the tabs.
    const underlayStyle = tabs.slice(tabs.indexOf('const underlayStyle = useAnimatedStyle('), tabs.indexOf('<Animated.View style={[styles.fill, underlayStyle]}>'));
    expect(underlayStyle.replace(/\s+/g, ' ')).toContain('useAnimatedStyle(() => ({ opacity: 1 - zoomUnderlayHidden.value * covered.value, }));');
    expect(tabs).not.toMatch(/display\s*:/);
    expect(tabs).toContain('useSharedValue(navigation.isFocused() ? 0 : 1)');
    expect(tabs).toContain("navigation.addListener('focus', () => covered.set(0))");
    expect(tabs).toContain("navigation.addListener('blur', () => covered.set(1))");
    expect(tabs.indexOf('<Animated.View style={[styles.fill, underlayStyle]}>')).toBeLessThan(tabs.indexOf('<Tabs'));
    expect(tabs.indexOf('</Tabs>')).toBeLessThan(tabs.indexOf('</Animated.View>'));
  });

  // The rule the tabs broke holds for any view over a list (`.claude/rules/mobile-runtime.md`): a new
  // `display: 'none'` in the app's own code fails here, so its author reads the rule first. One a list
  // can never sit under is added to the list below, with the reason.
  it('is not joined by another view that leaves layout', () => {
    const known = [
      // Help & Support's three panes, each a list: there before the rule, not yet checked for the fault.
      'app/support.tsx',
    ];
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(__dirname, '..', dir), { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name)) {
          const code = source(path).split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
          if (/display\s*:[^,;\n]*['"]none['"]/.test(code)) found.push(path);
        }
      }
    };
    ['app', 'components', 'lib'].forEach(walk);
    expect(found.sort()).toEqual(known);
  });
});
