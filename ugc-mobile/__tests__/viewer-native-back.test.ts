import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { viewerNativeBackOptions } from '../lib/viewer-native-back';

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

  it('is used on iOS only when there is a screen to go back to', () => {
    expect(viewer).toContain("const [nativeBack] = useState(() => Platform.OS === 'ios' && router.canGoBack());");
    expect(viewer).toContain('...(nativeBack ? viewerNativeBackOptions({');
    // Our own Back and Mute stand aside for the bar's; elsewhere they stay.
    expect(viewer).toContain('{detailsOpenForActive || nativeBack ? null : (');
    expect(viewer).toContain('{detailsOpenForActive || nativeBack || !hasImmersiveAudibleMedia(activeItem) ? null : (');
  });

  it('hears from the active slide as its swipe leaves the media page', () => {
    expect(viewer).toContain('onLeavesMedia={setLeavingMediaItemId}');
    expect(viewer).toContain('const leaving = offset > (detailsPageIndex - 1) * width + LEAVES_MEDIA_AFTER;');
    expect(viewer).toContain('if (activeRef.current) onLeavesMediaRef.current?.(leaving ? item.id : null);');
  });
});
