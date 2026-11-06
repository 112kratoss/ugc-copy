import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { LEAVES_MEDIA_AFTER, leavesMediaPage, viewerNativeBackOptions } from '../lib/viewer-native-back';

const viewer = readFileSync(join(__dirname, '..', 'app', 'viewer.tsx'), 'utf8');

describe('the reel\'s Back on iOS is the navigation bar\'s own', () => {
  it('shows a minimal, labelled Back over the post with no bar or shade of its own', () => {
    const options = viewerNativeBackOptions({ hidden: false, mute: null });
    expect(options).toMatchObject({
      headerShown: true,
      headerTransparent: true,
      title: '',
      headerBackTitle: 'Go back',
      headerBackButtonDisplayMode: 'minimal',
      headerBackButtonMenuEnabled: false,
      headerShadowVisible: false,
      headerStyle: { backgroundColor: 'transparent' },
      headerBlurEffect: 'none',
      scrollEdgeEffects: { top: 'hidden', bottom: 'hidden', left: 'hidden', right: 'hidden' },
    });
    expect(options.unstable_headerRightItems?.({ tintColor: '#ffffff', canGoBack: true })).toEqual([]);
  });

  it('takes the bar away while Details is open or being swiped to', () => {
    expect(viewerNativeBackOptions({ hidden: true, mute: null }).headerShown).toBe(false);
  });

  it('puts Mute beside Back, saying and showing which way it goes', () => {
    const onPress = vi.fn();
    const items = (muted: boolean) => viewerNativeBackOptions({ hidden: false, mute: { muted, onPress } })
      .unstable_headerRightItems?.({ tintColor: '#ffffff', canGoBack: true });
    expect(items(false)).toEqual([expect.objectContaining({
      type: 'button',
      accessibilityLabel: 'Mute video',
      icon: { type: 'sfSymbol', name: 'speaker.wave.2.fill' },
      selected: false,
    })]);
    const [unmute] = items(true) ?? [];
    expect(unmute).toEqual(expect.objectContaining({
      accessibilityLabel: 'Unmute video',
      icon: { type: 'sfSymbol', name: 'speaker.slash.fill' },
      selected: true,
    }));
    if (unmute?.type === 'button') unmute.onPress();
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('is used on iOS 26 only, and only when there is a screen to go back to', () => {
    expect(viewer).toContain("const [nativeBack] = useState(() => Platform.OS === 'ios' && isLiquidGlassAvailable() && router.canGoBack());");
    expect(viewer).toContain('...(nativeBack ? viewerNativeBackOptions({');
    // Our own Back and Mute stand aside for the bar's; elsewhere they stay.
    expect(viewer).toContain('{detailsOpenForActive || nativeBack ? null : (');
    expect(viewer).toContain('{detailsOpenForActive || nativeBack || !hasImmersiveAudibleMedia(activeItem) ? null : (');
  });

  it('hears from the active slide as its swipe leaves the media page, on iOS only', () => {
    expect(viewer).toContain('onLeavesMedia={nativeBack ? setLeavingMediaItemId : undefined}');
    expect(viewer).toContain('const leaving = leavesMediaPage(offset, detailsPageIndex, width);');
    expect(viewer).toContain('if (activeRef.current) onLeavesMediaRef.current?.(leaving ? item.id : null);');
    // A slide opened on Details starts out as having left the media.
    expect(viewer).toContain('useRef(leavesMediaPage(initialHorizontalOffset.x, detailsPageIndex, width))');
  });

  it('gives the bar back to the states drawn instead of the reel', () => {
    expect(viewer).toContain("const shellHidesBar = nativeBack ? <Stack.Screen options={{ headerShown: false }} /> : null;");
    // Unavailable, loading, could not load, nothing left: each keeps its own Back.
    expect(viewer.match(/<ViewerShell [^>]*>\n\s*\{shellHidesBar\}/g)).toHaveLength(4);
  });

  describe('leavesMediaPage', () => {
    const width = 402;
    it('never leaves on a post without a Details page', () => {
      expect(leavesMediaPage(5000, -1, width)).toBe(false);
      expect(leavesMediaPage(5000, 0, width)).toBe(false);
    });

    it('leaves once the swipe passes the last media page by the threshold', () => {
      expect(leavesMediaPage(0, 1, width)).toBe(false);
      expect(leavesMediaPage(LEAVES_MEDIA_AFTER, 1, width)).toBe(false);
      expect(leavesMediaPage(LEAVES_MEDIA_AFTER + 1, 1, width)).toBe(true);
      expect(leavesMediaPage(width, 1, width)).toBe(true);
    });

    it('stays between the media pages of a carousel', () => {
      // Three media pages, then Details: pages 0–2 keep the bar.
      expect(leavesMediaPage(width, 3, width)).toBe(false);
      expect(leavesMediaPage(2 * width, 3, width)).toBe(false);
      expect(leavesMediaPage(2 * width + LEAVES_MEDIA_AFTER + 1, 3, width)).toBe(true);
    });
  });
});
