import { useLayoutEffect, useRef } from 'react';
import type { LayoutChangeEvent, ScrollView } from 'react-native';

type ItemLayout = { x: number; width: number };

/**
 * What joined a rail between two looks: the ids that are new, when every id it held before is
 * still there. None on the first look, none into an empty rail (a draft restored after the
 * screen opened; a first pick fits anyway), and none when the rail was replaced or lost a
 * picture (a remix, a removal), which nobody just added.
 */
export function addedRailIds(before: readonly string[] | null, after: readonly string[]): string[] {
  if (!before || before.length === 0) return [];
  const now = new Set(after);
  if (!before.every((id) => now.has(id))) return [];
  const then = new Set(before);
  return after.filter((id) => !then.has(id));
}

/**
 * A horizontal rail that brings what was just added into view. The creator's add tiles stay
 * fixed at the start of their rails (the owner's "pin the add tile at the start of the rails",
 * 2026-10-21), and a picture added joins the end of the pictures beside them, past the edge
 * once they no longer fit, where only a counter said it had arrived. The newest one added is
 * scrolled to the rail's right edge as soon as its place is known, whichever of its layout and
 * the rail's look at its ids comes first. `endInset` is the space the rail keeps after its last
 * picture.
 */
export function useRailReveal(ids: readonly string[], endInset: number) {
  const scrollRef = useRef<ScrollView>(null);
  const seen = useRef<readonly string[] | null>(null);
  const pending = useRef<string | null>(null);
  const railWidth = useRef(0);
  const layouts = useRef(new Map<string, ItemLayout>());

  const reveal = (id: string) => {
    const item = layouts.current.get(id);
    if (!item || railWidth.current === 0) return false;
    scrollRef.current?.scrollTo({ x: Math.max(0, item.x + item.width + endInset - railWidth.current), animated: true });
    return true;
  };

  useLayoutEffect(() => {
    const added = addedRailIds(seen.current, ids);
    seen.current = ids;
    if (added.length === 0) return;
    const newest = added[added.length - 1];
    pending.current = reveal(newest) ? null : newest;
  }, [ids]);

  return {
    scrollRef,
    onRailLayout: (event: LayoutChangeEvent) => {
      railWidth.current = event.nativeEvent.layout.width;
    },
    itemLayout: (id: string) => (event: LayoutChangeEvent) => {
      const { x, width } = event.nativeEvent.layout;
      layouts.current.set(id, { x, width });
      if (pending.current === id && reveal(id)) pending.current = null;
    },
  };
}
