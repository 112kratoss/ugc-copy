import { describe, expect, it } from 'vitest';

/**
 * The reel's open on iOS 18 rides Expo Router's binding of UIKit's zoom
 * transition (lib/apple-zoom.ts). The tiles open imperatively, so the param
 * that carries the zoom is named here rather than by `Link`; this pins it to
 * Expo Router's own constant, so an upgrade that renames it fails here rather
 * than by silently opening every post with a plain push.
 */

import { INTERNAL_EXPO_ROUTER_ZOOM_TRANSITION_SOURCE_ID_PARAM_NAME } from 'expo-router/build/navigationParams';

import {
  APPLE_ZOOM_SOURCE_PARAM,
  appleZoomSourceId,
  hasAppleZoomParam,
  parseAppleZoomSourceId,
  withAppleZoom,
} from '../lib/apple-zoom';
import { immersivePreviewOpenHref, immersiveViewerHref, showcaseFeedItemOpenHref } from '../lib/immersive-preview-view-model';
import type { ImmersivePreviewItem } from '../lib/immersive-preview-view-model';
import type { ShowcaseFeedItem } from '../lib/types';

describe('the param that carries the zoom', () => {
  it('is the one Expo Router reads', () => {
    expect(APPLE_ZOOM_SOURCE_PARAM).toBe(INTERNAL_EXPO_ROUTER_ZOOM_TRANSITION_SOURCE_ID_PARAM_NAME);
  });

  it('names a tile by its surface and post, and reads either back — surfaces carry colons', () => {
    const id = appleZoomSourceId(':r1:', 'post-1');
    expect(parseAppleZoomSourceId(id)).toEqual({ surfaceId: ':r1:', itemId: 'post-1' });
    expect(appleZoomSourceId(':r1:', 'post-2')).not.toBe(id);
    expect(parseAppleZoomSourceId('something-else')).toBeNull();
    expect(parseAppleZoomSourceId(null)).toBeNull();
  });

  it('rides the viewer href only when a tile hands one over', () => {
    const plain = immersiveViewerHref({ source: 'showcase-feed', initialId: 'post-1' });
    expect(plain.params).not.toHaveProperty(APPLE_ZOOM_SOURCE_PARAM);
    expect(hasAppleZoomParam(plain.params)).toBe(false);

    const zoomed = immersiveViewerHref({ source: 'showcase-feed', initialId: 'post-1', zoom: { sourceId: 'zoom|:r1:|post-1' } });
    expect(zoomed.params[APPLE_ZOOM_SOURCE_PARAM as keyof typeof zoomed.params]).toBe('zoom|:r1:|post-1');
    expect(hasAppleZoomParam(zoomed.params)).toBe(true);

    expect(withAppleZoom({ pathname: '/viewer', params: { a: '1' } }, null)).toEqual({ pathname: '/viewer', params: { a: '1' } });
  });

  it('reaches the reel from every surface that builds the href', () => {
    const item = { id: 'media-1', mediaUrl: 'https://cdn.test/a.jpg', mediaKind: 'image', category: 'image' } as unknown as ShowcaseFeedItem;
    const zoom = { sourceId: 'zoom|home|media-1' };
    expect(showcaseFeedItemOpenHref({ item, source: 'creator-profile', zoom })).toMatchObject({
      params: { initialId: 'media-1', [APPLE_ZOOM_SOURCE_PARAM]: zoom.sourceId },
    });
    const previewItem = { id: 'media-1', previewKind: 'image', source: 'profile-saved', sourceType: 'saved' } as unknown as ImmersivePreviewItem;
    expect(immersivePreviewOpenHref(previewItem, { zoom })).toMatchObject({
      params: { initialId: 'media-1', [APPLE_ZOOM_SOURCE_PARAM]: zoom.sourceId },
    });
  });
});
