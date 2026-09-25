import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Heart, MessageCircle, Share, Share2 } from 'lucide-react-native';

vi.mock('react-native', () => ({
  Image: (props: Record<string, unknown>) => React.createElement('image', props),
}));
vi.mock('../lib/reel-icon-assets', () => ({ reelIconAssets: {
  'Heart|30|#ffffff|none|2.2|true': 1,
  'Heart|30|#ff3b64|#ff3b64|2.2|true': 2,
  'MessageCircle|30|#ffffff|none|2.2|false': 3,
  'Share|28|#ffffff|none|2.2|true': 4,
  'Share2|28|#ffffff|none|2.2|true': 5,
} }));
import { Image } from 'react-native';
import { renderReelIcon } from '../components/reel-icon';

describe('bundled reel glyphs', () => {
  it('keeps saved and unsaved hearts distinct with the same layout footprint', () => {
    const empty = renderReelIcon(<Heart size={30} color="#ffffff" fill="transparent" />, true)!;
    const saved = renderReelIcon(<Heart size={30} color="#ff3b64" fill="#ff3b64" />, true)!;
    expect(empty).toMatchObject({ props: { source: 1, accessible: false, style: { width: 36, height: 36, margin: -3 } } });
    expect(saved).toMatchObject({ props: { source: 2, style: { width: 36, height: 36, margin: -3 } } });
  });
  it('draws the raster as one native view that appears at once', () => {
    // React Native's Image, not expo-image (four native views on Android), and
    // without Android's default 300 ms fade-in.
    const glyph = renderReelIcon(<Heart size={30} color="#ffffff" fill="transparent" />, true)!;
    expect(glyph.type).toBe(Image);
    expect(glyph).toMatchObject({ props: { fadeDuration: 0, resizeMode: 'contain' } });
  });
  it('preserves the transparent comment and each platform share shape', () => {
    expect(renderReelIcon(<MessageCircle size={30} color="#ffffff" fill="transparent" />, false)).toMatchObject({ props: { source: 3 } });
    expect(renderReelIcon(<Share size={28} color="#ffffff" />, true)).toMatchObject({ props: { source: 4 } });
    expect(renderReelIcon(<Share2 size={28} color="#ffffff" />, true)).toMatchObject({ props: { source: 5 } });
  });
  it('leaves custom variants and decorated icons to their original SVG', () => {
    expect(renderReelIcon(<Heart size={30} color="#ffffff" strokeWidth={4} />, true)).toBeNull();
    expect(renderReelIcon(<Heart size={30} color="#ffffff" style={{ opacity: 0.5 }} />, true)).toBeNull();
    expect(renderReelIcon(<Heart size={30} color="#ffffff" accessibilityLabel="Heart" />, true)).toBeNull();
  });
});
