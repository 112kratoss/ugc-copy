// @vitest-environment node
import { describe, expect, it } from 'vitest';

import OpengraphImage, { size } from '@/app/blog/[slug]/opengraph-image';
import { getSortedPostsData } from '@/lib/blog';
import sharp from '@/lib/image-decoder';

/**
 * A shared blog link shows this card. Since 2026-11-28 it carries the brand's
 * icon, the app icon (owner: "add our main logo all the places it needs"),
 * beside the wordmark, where an orange dot stood before. The card is padded 80
 * px from the left and 72 px from the top, and the icon is 48 px square.
 */
describe("the blog's social card", () => {
  it('draws the brand icon at the top left, beside the wordmark', async () => {
    const [post] = getSortedPostsData();
    const response = await OpengraphImage({ params: Promise.resolve({ slug: post.slug }) });
    const png = Buffer.from(await response.arrayBuffer());
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([size.width, size.height]);

    const colourAt = (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      return { r: data[i], g: data[i + 1], b: data[i + 2] };
    };
    // The icon's purple ground, low in its left half (the old dot was 14 px and centred, so this was background).
    const inside = colourAt(80 + 6, 72 + 40);
    expect(inside.b - inside.g).toBeGreaterThan(30);
    expect(inside.r - inside.g).toBeGreaterThan(15);
    // The card's own ground just left of the icon stays the dark background.
    const outside = colourAt(60, 72 + 40);
    expect(Math.max(outside.r, outside.g, outside.b)).toBeLessThan(30);
  });
});
