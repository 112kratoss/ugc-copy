import { RecyclerViewManager } from '@shopify/flash-list/dist/recyclerview/RecyclerViewManager';

/**
 * A stand-in for the part of a phone FlashList's list manager talks to: it
 * draws the tiles the manager asks for, reports each one's real height back
 * (as a cell's measurement does after a commit), scrolls, and changes the data.
 * The manager, its masonry layout and its draw window are FlashList's own.
 */
export type DeviceTile = { id: string; height: number };

type Position = { x: number; y: number };

type ManagerInternals = {
  isFirstPaintOnUiComplete: boolean;
  engagedIndicesTracker: { scrollOffset: number };
};

export const DEVICE_WINDOW = { width: 360, height: 780 };
export const DEVICE_DRAW_DISTANCE = 900;
const COLUMN_WIDTH = DEVICE_WINDOW.width / 2;

/** `name` is what the data is given to the list as: the test's way to name it a feed (`keyedMasonryData`). */
export function createMasonryListDevice(
  initial: readonly DeviceTile[],
  name: (data: readonly DeviceTile[]) => readonly DeviceTile[] = (data) => data,
) {
  let data = name(initial);
  const props = () => ({
    data,
    masonry: true,
    numColumns: 2,
    optimizeItemArrangement: true,
    // Explore's (`SHOWCASE_DRAW_DISTANCE`): how far past the screen tiles are drawn.
    drawDistance: DEVICE_DRAW_DISTANCE,
    keyExtractor: (tile: DeviceTile) => tile.id,
    maintainVisibleContentPosition: { disabled: true },
    renderItem: () => null,
  });
  const manager = new RecyclerViewManager<DeviceTile>(props() as never);
  const internals = manager as unknown as ManagerInternals;
  // The first render: FlashList's hook takes the props and the data in, and the
  // layout that follows gives the list its window (`useRecyclerViewManager`).
  manager.updateProps(props() as never);
  manager.processDataUpdate();
  manager.updateLayoutParams(DEVICE_WINDOW, 0);

  /** Cells measure and report until the manager asks for no further render. */
  const settle = () => {
    for (let pass = 0; pass < 200; pass += 1) {
      const drawn = pass === 0 && manager.getRenderStack().size === 0
        ? []
        : Array.from(manager.getRenderStack().values()).map((entry) => entry.index);
      const measured = drawn
        .filter((index) => index < data.length)
        .map((index) => ({ index, dimensions: { width: COLUMN_WIDTH, height: data[index].height } }));
      const again = manager.modifyChildrenLayout(measured, data.length);
      internals.isFirstPaintOnUiComplete = true;
      if (!again) return;
    }
    throw new Error('the list never settled');
  };
  settle();
  settle();

  const offset = () => internals.engagedIndicesTracker.scrollOffset;
  let undrawn = 0;

  /** The tiles the reader would see as holes: on screen by the layout, and not among the cells drawn. */
  const countUndrawn = () => {
    const drawn = new Set(Array.from(manager.getRenderStack().values()).map((entry) => entry.index));
    const top = offset();
    data.forEach((_, index) => {
      const layout = manager.getLayout(index);
      if (layout.y + layout.height > top && layout.y < top + DEVICE_WINDOW.height && !drawn.has(index)) undrawn += 1;
    });
  };

  /** Where each tile on screen is drawn, measured from the top of the screen. */
  const onScreen = () => {
    const top = offset();
    const seen = new Map<string, Position>();
    data.forEach((tile, index) => {
      const layout = manager.getLayout(index);
      if (layout.y + layout.height > top && layout.y < top + DEVICE_WINDOW.height) {
        seen.set(tile.id, { x: layout.x, y: layout.y - top });
      }
    });
    return seen;
  };

  /**
   * Runs `step`, then the passes that follow it, and counts the tiles that were
   * on screen before and are drawn somewhere else on it after. `scrolledBy` is
   * how far the reader's own finger moved the list in the step.
   */
  const movesDuring = (step: () => void, scrolledBy = 0) => {
    const before = onScreen();
    step();
    settle();
    countUndrawn();
    const after = onScreen();
    let moved = 0;
    before.forEach((was, id) => {
      const now = after.get(id);
      if (!now) return;
      if (Math.abs(now.x - was.x) > 0.5 || Math.abs(now.y - (was.y - scrolledBy)) > 0.5) moved += 1;
    });
    return moved;
  };

  return {
    manager,
    offset,
    onScreen,
    tiles: () => data,
    /** How many times, over every step so far, a tile on screen was not drawn. */
    undrawn: () => undrawn,
    /** The reader scrolls to `to` in steps, as scroll events arrive; returns the on-screen moves. */
    scrollTo(to: number, stepSize = 60) {
      let moved = 0;
      while (Math.abs(to - offset()) > 0.5) {
        const from = offset();
        const next = to > from ? Math.min(to, from + stepSize) : Math.max(to, from - stepSize);
        moved += movesDuring(() => {
          manager.updateScrollOffset(next, { x: 0, y: next > from ? 1 : -1 });
        }, next - from);
      }
      return moved;
    },
    /** The reader scrolls until the grid ends, as far as a scroll view lets them. */
    scrollToEnd() {
      for (let pass = 0; pass < 50; pass += 1) {
        const end = manager.getMaxScrollOffset();
        if (Math.abs(end - offset()) < 0.5) return;
        this.scrollTo(end);
      }
      throw new Error('the list never reached its end');
    },
    /** The list is given new data, as a render with a new `data` prop does; returns the on-screen moves. */
    setData(next: readonly DeviceTile[]) {
      return movesDuring(() => {
        data = name(next);
        manager.updateProps(props() as never);
        manager.processDataUpdate();
      });
    },
    /** Every tile's place in the content, by post. */
    layouts() {
      return new Map(data.map((tile, index) => {
        const layout = manager.getLayout(index);
        return [tile.id, { x: layout.x, y: layout.y, height: layout.height }] as const;
      }));
    },
    layoutOf(id: string) {
      const index = data.findIndex((tile) => tile.id === id);
      const layout = manager.getLayout(index);
      return { x: layout.x, y: layout.y, height: layout.height };
    },
  };
}

/** Tiles at the shapes Explore draws: a column-wide picture at a common ratio over a caption. */
export function deviceTiles(count: number, prefix = 'post'): DeviceTile[] {
  const ratios = [1, 3 / 4, 9 / 16, 16 / 9, 4 / 5, 2 / 3];
  let seed = 7;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    height: Math.round(COLUMN_WIDTH / ratios[Math.floor(next() * ratios.length)]) + 44,
  }));
}
