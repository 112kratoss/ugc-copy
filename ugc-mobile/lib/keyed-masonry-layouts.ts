import { RVMasonryLayoutManagerImpl } from '@shopify/flash-list/dist/recyclerview/layout-managers/MasonryLayoutManager';
import { RecyclerViewManager } from '@shopify/flash-list/dist/recyclerview/RecyclerViewManager';

/**
 * A masonry grid whose tiles belong to their posts.
 *
 * FlashList 2.3.2 keeps what it knows of a tile (its measured height, where it
 * is placed) by the tile's index in the data, and on a data change only cuts or
 * grows the end of that list (`RVLayoutManager.modifyLayout`; its own
 * `deleteLayout` is never called). So when a post leaves the middle of the
 * data, every tile after it is laid out with the height of the post that used
 * to hold its index. The tiles on screen are measured again at once; the ones
 * above the screen are not, until the reader scrolls back up, and each one's
 * correction then re-places the tiles on screen. And the masonry decides every
 * tile's column again from the removal down (the shortest column wins), so the
 * tiles on screen trade columns the moment the post goes.
 *
 * Hiding or blocking a creator from a post deep in Explore did both: the grid
 * the reader came back to was arranged differently, and it kept rearranging on
 * the way up (the harness counted 119 on-screen moves after three removals,
 * `__tests__/flash-list-keyed-layouts.test.ts`).
 *
 * For a list whose data is named with `keyedMasonryData`, three things hold
 * instead, as they do in the platforms' own staggered grids:
 *
 * 1. A tile's layout follows its post across a data change, by key. A post
 *    that comes back (Undo) gets the layout it left with.
 * 2. A tile that has been drawn keeps its column. A post leaving above it, or
 *    a tile above it changing height, slides it within its column and never
 *    moves it across (short of `KEPT_COLUMN_REACH_IN_WINDOWS`). Tiles not drawn yet still go to the shorter column, so
 *    the columns even out again below what the reader has seen.
 * 3. The reader's place is kept: when tiles above the screen go or come back,
 *    the list's offset moves with the column on screen that moved least, so
 *    that column stays where it is (`takeKeyedMasonryShift`, applied to the
 *    native list by `useKeyedMasonryPlace`).
 *
 * This reaches into FlashList's list manager and masonry layout by replacing
 * two methods of the first and three of the second. It is JavaScript only, so it ships in an OTA; the
 * test above fails when the installed FlashList is not the version this was
 * read against, or no longer has the fault.
 */

const KEPT_COLUMN = Symbol('keptColumn');
const KEEPS_COLUMNS = Symbol('keepsColumns');
const KEPT_COLUMN_REACH = Symbol('keptColumnReach');
const OUT_OF_ORDER = Symbol('outOfOrder');

/**
 * How far ahead of the shortest column a kept column may place its tile, in
 * window heights. Kept columns stand apart by what left one and not the other,
 * and stay so as far down as the reader has been (tiles not reached yet even
 * them out). That is the price of a tile never changing column, and of an Undo
 * putting every tile back; this only stops a grid from running on as one
 * column for screens on end after many posts leave one side. Past the reach a
 * tile gives its column up and goes to the shortest, as FlashList would put it.
 */
const KEPT_COLUMN_REACH_IN_WINDOWS = 1.5;

type Layout = {
  x: number;
  y: number;
  width: number;
  height: number;
  isHeightMeasured?: boolean;
  isWidthMeasured?: boolean;
  [KEPT_COLUMN]?: { column: number; of: number };
};

type MasonryInternals = {
  layouts: Layout[];
  spanTracker?: (number | undefined)[];
  columnHeights: number[];
  boundedSize: number;
  maxColumns: number;
  windowSize: { width: number; height: number };
  recomputeLayouts: (startIndex: number, endIndex: number) => void;
  placeSingleColumnItem: (layout: Layout) => void;
  getVisibleLayouts: (start: number, end: number) => unknown;
  getSpan?: (index: number, skipTracking?: boolean) => number;
  [KEEPS_COLUMNS]?: boolean;
  [KEPT_COLUMN_REACH]?: number;
  /** How far out of order down the grid a tile can be: what the search for the tiles to draw is widened by. */
  [OUT_OF_ORDER]?: number;
};

type ManagerInternals = {
  propsRef: {
    data?: readonly unknown[] | null;
    masonry?: boolean;
    keyExtractor?: (item: unknown, index: number) => string;
  };
  layoutManager?: MasonryInternals;
  engagedIndicesTracker: { scrollOffset: number; drawDistance: number };
  firstItemOffset: number;
  processDataUpdate: () => void;
  updateLayoutParams: (...args: unknown[]) => void;
};

type ListState = {
  scope: string;
  keys: string[];
  /** Layouts of posts that left, so one that comes back is laid out as it was. */
  left: Map<string, Layout>;
  /** The last time posts left: which, and where the list was before and after, for their return. */
  lastLeaving?: { keys: Set<string>; offsetBefore: number; offsetAfter: number };
  /**
   * How far past the last tile the list scrolls (its footer and bottom
   * padding), as seen when a change found the reader down there.
   */
  tail: number;
};

const LEFT_LAYOUTS_KEPT = 400;

const scopeByData = new WeakMap<object, string>();
const shiftByData = new WeakMap<object, number>();
const stateByManager = new WeakMap<object, ListState>();

/**
 * Names `data` as the posts of one feed, `scope`, and returns it. A FlashList
 * masonry given data named this way lays its tiles out by post. Another scope
 * is another feed: its tiles start afresh.
 */
export function keyedMasonryData<T extends readonly unknown[]>(data: T, scope: string): T {
  scopeByData.set(data, scope);
  return data;
}

/**
 * How far the list given `data` moved its own offset to keep the reader's
 * place, once: the native list has to be scrolled to the list's offset.
 */
export function takeKeyedMasonryShift(data: readonly unknown[] | null | undefined): number {
  if (!data) return 0;
  const shift = shiftByData.get(data) ?? 0;
  shiftByData.delete(data);
  return shift;
}

export type KeyedLayoutMove = {
  /** For each index of the new data, the index its post had before, or -1 for a post not there before. */
  from: number[];
  /** The first index whose post is not the one that held it before. */
  firstChanged: number;
  /** Whether the posts that stayed are still in the order they were in. */
  keepsOrder: boolean;
};

/**
 * What a data change does to the tiles, or null when it moves none: the same
 * posts in the same places, with or without more at the end (a next page) or
 * fewer (a lane trimmed to its first page).
 */
export function planKeyedLayoutMove(previous: readonly string[], next: readonly string[]): KeyedLayoutMove | null {
  const shared = Math.min(previous.length, next.length);
  let firstChanged = 0;
  while (firstChanged < shared && previous[firstChanged] === next[firstChanged]) firstChanged += 1;
  if (firstChanged === shared) return null;

  const previousIndex = new Map<string, number>();
  previous.forEach((key, index) => previousIndex.set(key, index));
  let keepsOrder = true;
  let last = -1;
  const from = next.map((key) => {
    const index = previousIndex.get(key) ?? -1;
    if (index >= 0) {
      if (index < last) keepsOrder = false;
      last = index;
    }
    return index;
  });
  return { from, firstChanged, keepsOrder };
}

function freshLayout(): Layout {
  return { x: 0, y: 0, width: 0, height: 0 };
}

function isMasonry(layoutManager: unknown): layoutManager is MasonryInternals {
  const candidate = layoutManager as MasonryInternals | undefined;
  return Boolean(candidate)
    && Array.isArray(candidate!.layouts)
    && Array.isArray(candidate!.columnHeights)
    && typeof candidate!.recomputeLayouts === 'function';
}

/**
 * The topmost tile on screen in each column, among the posts that stay: the
 * tiles one of which is kept where it is.
 */
function topmostOnScreenByColumn(manager: ManagerInternals, layouts: Layout[], stays: (index: number) => boolean) {
  const top = manager.engagedIndicesTracker.scrollOffset;
  const bottom = top + manager.layoutManager!.windowSize.height;
  const found = new Map<number, number>();
  for (let index = 0; index < layouts.length; index += 1) {
    const layout = layouts[index];
    if (!layout || layout.y + layout.height <= top || layout.y >= bottom || !stays(index)) continue;
    const held = found.get(layout.x);
    if (held === undefined || layout.y < layouts[held].y) found.set(layout.x, index);
  }
  return [...found.values()].map((index) => ({ index, y: layouts[index].y }));
}

/** Says of a list's layout whether its tiles keep their columns, and how far apart the columns may then stand. */
function setKeepsColumns(manager: ManagerInternals, keeps: boolean) {
  const layoutManager = manager.layoutManager;
  if (!isMasonry(layoutManager)) return;
  layoutManager[KEEPS_COLUMNS] = keeps;
  layoutManager[KEPT_COLUMN_REACH] = keeps ? layoutManager.windowSize.height * KEPT_COLUMN_REACH_IN_WINDOWS : 0;
  if (!keeps) layoutManager[OUT_OF_ORDER] = 0;
}

/** Has FlashList note the span of the tiles it has no span for, as it does for a tile new at the end. */
function noteSpans(layoutManager: MasonryInternals) {
  const spans = layoutManager.spanTracker;
  if (!spans || typeof layoutManager.getSpan !== 'function') return;
  spans.length = layoutManager.layouts.length;
  for (let index = 0; index < spans.length; index += 1) {
    if (spans[index] === undefined) layoutManager.getSpan(index);
  }
}

function followPosts(manager: ManagerInternals) {
  const { data, keyExtractor, masonry } = manager.propsRef;
  const scope = data ? scopeByData.get(data) : undefined;
  const layoutManager = isMasonry(manager.layoutManager) ? manager.layoutManager : undefined;
  if (!data || scope === undefined || !masonry || !keyExtractor) {
    stateByManager.delete(manager);
    setKeepsColumns(manager, false);
    return;
  }

  const previous = stateByManager.get(manager);
  const keys = data.map((item, index) => keyExtractor(item, index));
  const sameFeed = previous?.scope === scope;
  const state: ListState = {
    scope,
    keys,
    left: sameFeed ? previous.left : new Map(),
    lastLeaving: sameFeed ? previous.lastLeaving : undefined,
    tail: sameFeed ? previous.tail : 0,
  };
  stateByManager.set(manager, state);
  if (!layoutManager) return;
  setKeepsColumns(manager, true);
  if (!previous || layoutManager.layouts.length !== previous.keys.length) return;

  if (previous.scope !== scope) {
    // Another feed. Its tiles are not these, so none keeps a height or a column.
    const fresh = keys.map(freshLayout);
    layoutManager.layouts.length = 0;
    layoutManager.layouts.push(...fresh);
    if (layoutManager.spanTracker) layoutManager.spanTracker.length = 0;
    noteSpans(layoutManager);
    layoutManager.recomputeLayouts(0, fresh.length - 1);
    return;
  }

  const move = planKeyedLayoutMove(previous.keys, keys);
  if (!move) return;

  const before = layoutManager.layouts.slice();
  const spansBefore = layoutManager.spanTracker?.slice();
  const tracker = manager.engagedIndicesTracker;
  const offsetBefore = tracker.scrollOffset;
  const windowHeight = layoutManager.windowSize.height;
  const start = -manager.firstItemOffset;
  // The list ends below its last tile, by a footer this layout knows nothing
  // of. A reader at the very end shows how far: the list is kept within that.
  // (A grid shorter than its window does not scroll, and shows nothing.)
  const pastTiles = offsetBefore - Math.max(start, Math.max(0, ...layoutManager.columnHeights) - windowHeight);
  if (pastTiles > 0) state.tail = Math.min(pastTiles, windowHeight);
  const stays = new Set<number>();
  move.from.forEach((index) => {
    if (index >= 0) stays.add(index);
  });
  const anchors = move.keepsOrder ? topmostOnScreenByColumn(manager, before, (index) => stays.has(index)) : [];

  previous.keys.forEach((key, index) => {
    if (stays.has(index) || !before[index]) return;
    state.left.delete(key);
    state.left.set(key, before[index]);
  });
  while (state.left.size > LEFT_LAYOUTS_KEPT) {
    state.left.delete(state.left.keys().next().value as string);
  }

  let newPosts = 0;
  const after = move.from.map((index, nextIndex) => {
    if (index >= 0 && before[index]) return before[index];
    const returning = state.left.get(keys[nextIndex]);
    if (returning) {
      state.left.delete(keys[nextIndex]);
      return returning;
    }
    newPosts += 1;
    return freshLayout();
  });
  if (!move.keepsOrder) {
    // A new order (a refresh): heights still belong to their posts, columns are decided again.
    after.forEach((layout) => {
      delete layout[KEPT_COLUMN];
    });
  }

  layoutManager.layouts.length = 0;
  layoutManager.layouts.push(...after);
  if (layoutManager.spanTracker && spansBefore) {
    layoutManager.spanTracker.length = 0;
    layoutManager.spanTracker.push(...move.from.map((index) => (index >= 0 ? spansBefore[index] : undefined)));
  }
  noteSpans(layoutManager);
  layoutManager.recomputeLayouts(move.firstChanged, after.length - 1);

  const end = Math.max(start, Math.max(0, ...layoutManager.columnHeights) - windowHeight + state.tail);
  const leaving = new Set(previous.keys.filter((_, index) => !stays.has(index)));
  const arriving = keys.filter((_, index) => move.from[index] < 0);
  const returning = state.lastLeaving;
  state.lastLeaving = undefined;

  let offset = offsetBefore;
  if (
    returning
    && leaving.size === 0
    && arriving.length === returning.keys.size
    && arriving.every((key) => returning.keys.has(key))
    && Math.abs(offsetBefore - returning.offsetAfter) < 2
  ) {
    // The posts that just left are back and the reader has not moved (Undo):
    // the list goes back to where it was, whatever stopped it short then (the
    // end of a grid that had become shorter).
    offset = returning.offsetBefore;
  } else if (newPosts === 0) {
    // The tiles of a column move as one when posts above the screen go or
    // come back, and the two columns by different amounts. The list follows
    // the column that moved least: that column stays where it is on screen. A
    // post removed on screen leaves the other column, and so the list, still.
    // Each tile's layout is the one object it had before, now at its new place.
    // Not when posts the list has never held arrive (a refresh, "New posts"):
    // the reader asked for those, and the list stays where it is, as it did.
    let shift = 0;
    anchors.forEach((anchor, at) => {
      const moved = before[anchor.index].y - anchor.y;
      if (at === 0 || Math.abs(moved) < Math.abs(shift)) shift = moved;
    });
    offset = offsetBefore + shift;
  }
  // Kept within the grid, but never brought into it from where the list
  // already rests outside (an iPhone holding its refresh control open).
  offset = Math.min(Math.max(Math.min(start, offsetBefore), offset), Math.max(end, Math.min(start, offsetBefore)));
  if (leaving.size > 0 && arriving.length === 0 && move.keepsOrder) {
    state.lastLeaving = { keys: leaving, offsetBefore, offsetAfter: offset };
  }
  if (Math.abs(offset - offsetBefore) < 0.5) return;
  shiftByData.set(data, offset - offsetBefore);
  tracker.scrollOffset = offset;
}

/**
 * How far out of order down the grid a tile of this layout can be: the most a
 * tile stands ahead of the shortest column where it is placed, and, when any
 * does, the tallest tile on top (the search asks where a tile ends, not where
 * it begins). 0 for a grid laid out by the shortest-column rule alone.
 */
function outOfOrder(layoutManager: MasonryInternals) {
  const columnWidth = layoutManager.boundedSize / layoutManager.maxColumns;
  const heights: number[] = new Array(layoutManager.maxColumns).fill(0);
  let ahead = 0;
  let tallest = 0;
  for (const layout of layoutManager.layouts) {
    if (!layout) continue;
    const first = Math.min(layoutManager.maxColumns - 1, Math.max(0, Math.round(layout.x / columnWidth)));
    const last = Math.min(layoutManager.maxColumns, first + Math.max(1, Math.round(layout.width / columnWidth)));
    if (last - first === 1) ahead = Math.max(ahead, layout.y - Math.min(...heights));
    for (let column = first; column < last; column += 1) {
      heights[column] = Math.max(heights[column], layout.y + layout.height);
    }
    tallest = Math.max(tallest, layout.height);
  }
  return ahead > 0.5 ? ahead + tallest : 0;
}

function columnOf(layoutManager: MasonryInternals, layout: Layout) {
  return Math.round(layout.x / (layoutManager.boundedSize / layoutManager.maxColumns));
}

let installed: (() => void) | null = null;

/**
 * Replaces the five FlashList methods, once. Returns what puts FlashList's own
 * back (the tests' control), or null when the installed FlashList does not
 * have the methods this was written against, and is left as it is.
 */
export function installKeyedMasonryLayouts(): (() => void) | null {
  if (installed) return installed;
  const managerPrototype = RecyclerViewManager.prototype as unknown as ManagerInternals;
  const masonryPrototype = RVMasonryLayoutManagerImpl.prototype as unknown as MasonryInternals;
  const stockProcessDataUpdate = managerPrototype.processDataUpdate;
  const stockUpdateLayoutParams = managerPrototype.updateLayoutParams;
  const stockPlace = masonryPrototype.placeSingleColumnItem;
  const stockRecompute = masonryPrototype.recomputeLayouts;
  // The base class's, which the masonry inherits: ours goes on the masonry alone.
  const stockVisible = masonryPrototype.getVisibleLayouts;
  if (
    typeof stockProcessDataUpdate !== 'function'
    || typeof stockUpdateLayoutParams !== 'function'
    || typeof stockPlace !== 'function'
    || typeof stockRecompute !== 'function'
    || typeof stockVisible !== 'function'
  ) {
    return null;
  }

  managerPrototype.processDataUpdate = function processDataUpdate(this: ManagerInternals) {
    try {
      followPosts(this);
    } catch {
      // FlashList's own handling below still runs: the grid is laid out by index, as before.
      stateByManager.delete(this);
    }
    stockProcessDataUpdate.call(this);
  };

  // The layout manager is made here, after the first data has been seen.
  managerPrototype.updateLayoutParams = function updateLayoutParams(this: ManagerInternals, ...args: unknown[]) {
    stockUpdateLayoutParams.apply(this, args);
    setKeepsColumns(this, stateByManager.has(this));
  };

  masonryPrototype.placeSingleColumnItem = function placeSingleColumnItem(this: MasonryInternals, layout: Layout) {
    const kept = this[KEEPS_COLUMNS] ? layout[KEPT_COLUMN] : undefined;
    if (kept && kept.of === this.maxColumns) {
      const ahead = this.columnHeights[kept.column] - Math.min(...this.columnHeights);
      if (ahead <= (this[KEPT_COLUMN_REACH] ?? 0)) {
        layout.x = (this.boundedSize / this.maxColumns) * kept.column;
        layout.y = this.columnHeights[kept.column];
        this.columnHeights[kept.column] += layout.height;
        return;
      }
      // Too far ahead of the shortest column (`KEPT_COLUMN_REACH_IN_WINDOWS`):
      // the tile is placed as FlashList places it, and keeps that column from here.
      delete layout[KEPT_COLUMN];
    }
    stockPlace.call(this, layout);
  };

  masonryPrototype.recomputeLayouts = function recomputeLayouts(
    this: MasonryInternals,
    startIndex: number,
    endIndex: number,
  ) {
    stockRecompute.call(this, startIndex, endIndex);
    if (!this[KEEPS_COLUMNS]) return;
    // A tile keeps the column it has once it and every tile before it have
    // been measured: the choice then rests on real heights, and is the one
    // FlashList itself would go on making. Chosen any earlier, on estimates,
    // kept columns would drift apart in height.
    let measured = 0;
    while (measured < this.layouts.length && this.layouts[measured]?.isHeightMeasured) measured += 1;
    for (let index = startIndex; index < measured; index += 1) {
      const layout = this.layouts[index];
      if (!layout[KEPT_COLUMN] || layout[KEPT_COLUMN].of !== this.maxColumns) {
        layout[KEPT_COLUMN] = { column: columnOf(this, layout), of: this.maxColumns };
      }
    }
    this[OUT_OF_ORDER] = outOfOrder(this);
  };

  // FlashList finds the tiles to draw with a binary search that takes them to
  // lie in order down the grid: the shortest-column rule guarantees it, and a
  // kept column does not, so a tile on screen could be left out (30 of them in
  // the test, after four posts left one column). The search is widened by how
  // far out of order a tile can be; it then finds a few more tiles than are
  // near the screen, and never fewer. Nothing is widened while every tile is
  // where FlashList would put it.
  masonryPrototype.getVisibleLayouts = function getVisibleLayouts(this: MasonryInternals, start: number, end: number) {
    const wider = this[KEEPS_COLUMNS] ? this[OUT_OF_ORDER] ?? 0 : 0;
    return stockVisible.call(this, start - wider, end + wider);
  };

  installed = () => {
    managerPrototype.processDataUpdate = stockProcessDataUpdate;
    managerPrototype.updateLayoutParams = stockUpdateLayoutParams;
    masonryPrototype.placeSingleColumnItem = stockPlace;
    masonryPrototype.recomputeLayouts = stockRecompute;
    delete (masonryPrototype as Partial<MasonryInternals>).getVisibleLayouts;
    installed = null;
  };
  return installed;
}

installKeyedMasonryLayouts();
