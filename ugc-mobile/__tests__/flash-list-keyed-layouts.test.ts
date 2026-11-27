import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  PixelRatio: {
    get: () => 3,
    getPixelSizeForLayoutSize: (size: number) => Math.round(size * 3),
    roundToNearestPixel: (size: number) => Math.round(size * 3) / 3,
  },
  Platform: { OS: 'android', select: (options: Record<string, unknown>) => options.android ?? options.default },
  View: 'View',
}));

import {
  installKeyedMasonryLayouts,
  keyedMasonryData,
  planKeyedLayoutMove,
  takeKeyedMasonryShift,
} from '@/lib/keyed-masonry-layouts';

import {
  createMasonryListDevice,
  DEVICE_DRAW_DISTANCE,
  DEVICE_WINDOW,
  deviceTiles,
  type DeviceTile,
} from './support/masonry-list-device';

const asFeed = (scope: string) => (data: readonly DeviceTile[]) => keyedMasonryData(data, scope);

/** The reader is deep in the grid; three posts of one creator sit above the screen. */
function deepInTheGrid(name?: (data: readonly DeviceTile[]) => readonly DeviceTile[]) {
  const tiles = deviceTiles(90);
  const device = createMasonryListDevice(tiles, name);
  device.scrollTo(5200);
  const above = [tiles[6], tiles[13], tiles[21]];
  above.forEach((tile) => {
    const layout = device.layoutOf(tile.id);
    expect(layout.y + layout.height).toBeLessThan(device.offset());
  });
  const without = tiles.filter((tile) => !above.includes(tile));
  return { tiles, device, above, without };
}

afterEach(() => {
  installKeyedMasonryLayouts();
});

describe('FlashList as installed', () => {
  it('is the version the keyed layouts were read against', () => {
    // lib/keyed-masonry-layouts.ts replaces four of FlashList's own methods
    // and reads its private fields. On a new version: read
    // RecyclerViewManager.processDataUpdate and updateLayoutParams,
    // RVLayoutManager.modifyLayout and RVMasonryLayoutManagerImpl's
    // recomputeLayouts and placeSingleColumnItem again, run this file, check
    // Explore on a device, then move this pin.
    const manifest = JSON.parse(readFileSync(
      path.resolve(__dirname, '../node_modules/@shopify/flash-list/package.json'),
      'utf8',
    )) as { version: string };
    expect(manifest.version).toBe('2.3.2');
    expect(installKeyedMasonryLayouts()).not.toBeNull();
  });

  it('still lays tiles out by index when left alone (the fault this replaces)', () => {
    // When this fails FlashList has fixed it: delete lib/keyed-masonry-layouts.ts.
    installKeyedMasonryLayouts()?.();
    const { device, without } = deepInTheGrid();
    device.setData(without);
    expect(device.scrollTo(0)).toBeGreaterThan(20);
  });

  it('leaves a list alone whose data is not named a feed', () => {
    const named = deepInTheGrid();
    installKeyedMasonryLayouts()?.();
    const stock = deepInTheGrid();
    named.device.setData(named.without);
    stock.device.setData(stock.without);
    expect(named.device.layouts()).toEqual(stock.device.layouts());
  });
});

describe('a masonry whose tiles follow their posts', () => {
  it('lays a plain read out exactly as FlashList does, and moves no tile on screen', () => {
    const keyed = createMasonryListDevice(deviceTiles(90), asFeed('all'));
    expect(keyed.scrollTo(5200)).toBe(0);
    expect(keyed.scrollTo(0)).toBe(0);
    keyed.scrollTo(7000);

    installKeyedMasonryLayouts()?.();
    const stock = createMasonryListDevice(deviceTiles(90));
    stock.scrollTo(5200);
    stock.scrollTo(0);
    stock.scrollTo(7000);
    expect(keyed.layouts()).toEqual(stock.layouts());
  });

  it('moves no tile on screen while the reader scrolls back up past removed posts', () => {
    const { device, without } = deepInTheGrid(asFeed('all'));
    device.setData(without);
    expect(device.scrollTo(0)).toBe(0);
  });

  it('keeps every tile in its column, and one column where it is, when posts above go', () => {
    const { device, without } = deepInTheGrid(asFeed('all'));
    const before = device.onScreen();
    device.setData(without);
    const after = device.onScreen();

    // Each column slid as one: its tiles all moved by the same amount.
    const slides = new Map<number, Set<number>>();
    before.forEach((was, id) => {
      const now = after.get(id);
      if (!now) return;
      expect(now.x).toBe(was.x);
      slides.set(was.x, (slides.get(was.x) ?? new Set()).add(Math.round(now.y - was.y)));
    });
    expect(slides.size).toBe(2);
    slides.forEach((amounts) => expect(amounts.size).toBe(1));
    const moved = [...slides.values()].map((amounts) => Math.abs([...amounts][0])).sort((a, b) => a - b);
    // Two of the posts were in one column and one in the other.
    expect(moved[0]).toBe(0);
    expect(moved[1]).toBeGreaterThan(0);
  });

  it('tells the screen how far the list moved to keep the place, once', () => {
    const { device, without } = deepInTheGrid(asFeed('all'));
    const offsetBefore = device.offset();
    device.setData(without);
    const shift = takeKeyedMasonryShift(device.tiles());
    expect(shift).toBeLessThan(0);
    expect(device.offset()).toBe(offsetBefore + shift);
    expect(takeKeyedMasonryShift(device.tiles())).toBe(0);
  });

  it('puts every tile back where it was when the posts come back (Undo)', () => {
    const { device, tiles, without } = deepInTheGrid(asFeed('all'));
    const layoutsBefore = device.layouts();
    const screenBefore = device.onScreen();
    const offsetBefore = device.offset();
    device.setData(without);
    device.setData(tiles);
    // Every tile the reader has reached: the ones further down have never been
    // drawn, and their places are estimates that move with each measurement.
    const reached = (layouts: typeof layoutsBefore) => new Map(
      [...layouts].filter(([id]) => layoutsBefore.get(id)!.y < offsetBefore + DEVICE_WINDOW.height),
    );
    expect(reached(layoutsBefore).size).toBeGreaterThan(40);
    expect(reached(device.layouts())).toEqual(reached(layoutsBefore));
    expect(device.offset()).toBe(offsetBefore);
    const screenAfter = device.onScreen();
    screenBefore.forEach((at, id) => expect(screenAfter.get(id)).toEqual(at));
    expect(device.scrollTo(0)).toBe(0);
  });

  it('returns the reader to the end of the grid when posts hidden from there come back', () => {
    const tiles = deviceTiles(90);
    const device = createMasonryListDevice(tiles, asFeed('all'));
    device.scrollToEnd();
    // The list ends below its last tile: a footer the layout knows nothing of.
    const footer = 420;
    device.manager.updateScrollOffset(device.offset() + footer);
    const end = device.offset();
    const screenBefore = device.onScreen();
    const fewer = tiles.filter((_, index) => ![60, 64, 71, 75].includes(index));
    device.setData(fewer);
    // The grid is shorter, and the list is at its new end, footer and all.
    expect(device.offset()).toBeLessThan(end);
    expect(device.offset()).toBe(device.manager.getMaxScrollOffset() + footer);
    device.setData(tiles);
    expect(device.offset()).toBe(end);
    expect(device.onScreen()).toEqual(screenBefore);
  });

  it('keeps the reader where they scrolled to when the posts come back later', () => {
    const { device, tiles, without } = deepInTheGrid(asFeed('all'));
    device.setData(without);
    device.scrollTo(device.offset() - 900);
    const screenBefore = device.onScreen();
    device.setData(tiles);
    const screenAfter = device.onScreen();
    // One column is where it was; the reader was not taken back to the place of the hide.
    const still = [...screenBefore].filter(([id, at]) => screenAfter.get(id)?.y === at.y);
    expect(still.length).toBeGreaterThan(0);
  });

  it('draws every tile on screen after posts leave one column only, all the way up and down', () => {
    // Kept columns stand apart by what left; FlashList finds the tiles to
    // draw taking them to lie in order down the grid (review of #955, finding 1).
    const tiles = deviceTiles(90);
    const device = createMasonryListDevice(tiles, asFeed('all'));
    device.scrollTo(5200);
    const left = tiles.slice(4, 30).filter((tile) => device.layoutOf(tile.id).x === 0).slice(0, 4);
    expect(left).toHaveLength(4);
    device.setData(tiles.filter((tile) => !left.includes(tile)));
    device.scrollTo(0, 37);
    device.scrollTo(9000, 37);
    device.scrollTo(0, 113);
    expect(device.undrawn()).toBe(0);
    // The columns are back within a tile or so of each other below what left.
    const layouts = [...device.layouts().values()];
    const ends = [0, DEVICE_WINDOW.width / 2].map((x) => Math.max(
      ...layouts.filter((layout) => layout.x === x).map((layout) => layout.y + layout.height),
    ));
    expect(Math.abs(ends[0] - ends[1])).toBeLessThanOrEqual(DEVICE_DRAW_DISTANCE * 0.45 + 1);
  });

  it('stays where it is when posts it has never held arrive above the screen (a refresh)', () => {
    const tiles = deviceTiles(60);
    const device = createMasonryListDevice(tiles, asFeed('all'));
    device.scrollTo(2600);
    const offsetBefore = device.offset();
    device.setData([...deviceTiles(3, 'new'), ...tiles]);
    expect(device.offset()).toBe(offsetBefore);
    expect(takeKeyedMasonryShift(device.tiles())).toBe(0);

    const atTop = createMasonryListDevice(tiles, asFeed('all'));
    atTop.setData([...deviceTiles(3, 'new'), ...tiles]);
    expect(atTop.offset()).toBe(0);
    expect(takeKeyedMasonryShift(atTop.tiles())).toBe(0);
  });

  it('leaves a list alone that rests above its top (an iPhone holding its refresh control open)', () => {
    const tiles = deviceTiles(60);
    const device = createMasonryListDevice(tiles, asFeed('all'));
    device.manager.updateScrollOffset(-60);
    device.setData(tiles.filter((_, index) => index !== 1));
    expect(device.offset()).toBe(-60);
    expect(takeKeyedMasonryShift(device.tiles())).toBe(0);
  });

  it('closes the gap under a post removed on screen and leaves the other column still', () => {
    const tiles = deviceTiles(90);
    const device = createMasonryListDevice(tiles, asFeed('all'));
    device.scrollTo(3000);
    const before = device.onScreen();
    const offsetBefore = device.offset();
    // A tile wholly on screen, not the topmost.
    const [removed, removedAt] = [...before.entries()]
      .filter(([, at]) => at.y > 0)
      .sort((first, second) => first[1].y - second[1].y)[0];
    device.setData(tiles.filter((tile) => tile.id !== removed));
    const after = device.onScreen();

    expect(device.offset()).toBe(offsetBefore);
    before.forEach((was, id) => {
      const now = after.get(id);
      if (!now) return;
      expect(now.x).toBe(was.x);
      if (was.x !== removedAt.x || was.y < removedAt.y) expect(now.y).toBe(was.y);
      else expect(now.y).toBeLessThan(was.y);
    });
  });

  it('evens the columns out again in the posts the reader has not reached', () => {
    const { device, tiles, without } = deepInTheGrid(asFeed('all'));
    device.setData(without);
    device.scrollTo(9000);
    const layouts = [...device.layouts().values()];
    const ends = [0, DEVICE_WINDOW.width / 2].map((x) => Math.max(
      ...layouts.filter((layout) => layout.x === x).map((layout) => layout.y + layout.height),
    ));
    const tallest = Math.max(...tiles.map((tile) => tile.height));
    expect(Math.abs(ends[0] - ends[1])).toBeLessThanOrEqual(tallest);
  });

  it('starts another feed afresh: no height or column of the feed before it', () => {
    let scope = 'all';
    const device = createMasonryListDevice(deviceTiles(90), (data) => keyedMasonryData(data, scope));
    device.scrollTo(5200);
    // Free's posts are some of All's, in All's order: by keys alone, a removal.
    const free = deviceTiles(90).filter((_, index) => index % 3 === 0);
    scope = 'free';
    device.setData(free);
    expect(takeKeyedMasonryShift(device.tiles())).toBe(0);
    device.manager.updateScrollOffset(0);
    device.scrollTo(3000);

    installKeyedMasonryLayouts()?.();
    const stock = createMasonryListDevice(free);
    stock.scrollTo(3000);
    expect(device.layouts()).toEqual(stock.layouts());
  });

  it('keeps heights and decides columns again when the same posts arrive in a new order (a refresh)', () => {
    const tiles = deviceTiles(60);
    const device = createMasonryListDevice(tiles, asFeed('all'));
    device.scrollTo(2600);
    const offsetBefore = device.offset();
    const reordered = [...tiles.slice(30, 60), ...tiles.slice(0, 30)];
    device.setData(reordered);
    expect(device.offset()).toBe(offsetBefore);
    expect(takeKeyedMasonryShift(device.tiles())).toBe(0);
    // The posts the reader had reached keep the heights they were measured at.
    tiles.slice(0, 20).forEach((tile) => expect(device.layoutOf(tile.id).height).toBe(tile.height));

    installKeyedMasonryLayouts()?.();
    const stock = createMasonryListDevice(reordered);
    stock.scrollTo(9000);
    installKeyedMasonryLayouts();
    device.scrollTo(0);
    device.scrollTo(9000);
    expect(device.layouts()).toEqual(stock.layouts());
  });
});

describe('planKeyedLayoutMove', () => {
  it('moves nothing for the same posts, a next page, or a trimmed end', () => {
    expect(planKeyedLayoutMove(['a', 'b', 'c'], ['a', 'b', 'c'])).toBeNull();
    expect(planKeyedLayoutMove(['a', 'b'], ['a', 'b', 'c', 'd'])).toBeNull();
    expect(planKeyedLayoutMove(['a', 'b', 'c'], ['a'])).toBeNull();
    expect(planKeyedLayoutMove([], ['a'])).toBeNull();
  });

  it('says where each post was, from the first index that changed', () => {
    expect(planKeyedLayoutMove(['a', 'b', 'c', 'd'], ['a', 'c', 'd'])).toEqual({
      from: [0, 2, 3],
      firstChanged: 1,
      keepsOrder: true,
    });
    expect(planKeyedLayoutMove(['a', 'c', 'd'], ['a', 'b', 'c', 'd'])).toEqual({
      from: [0, -1, 1, 2],
      firstChanged: 1,
      keepsOrder: true,
    });
  });

  it('says when the posts that stayed changed order', () => {
    expect(planKeyedLayoutMove(['a', 'b', 'c'], ['c', 'x', 'a'])?.keepsOrder).toBe(false);
  });
});
