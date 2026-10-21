import { useLayoutEffect, useRef } from 'react';
import type { LayoutChangeEvent, ScrollView } from 'react-native';

/** Asks a rail to bring one item into view; `serial` grows with every ask. */
export type RailRevealRequest = { id: string; serial: number };

/** The next ask after `current`, for the item just added. */
export function nextRailRevealRequest(current: RailRevealRequest | null, id: string): RailRevealRequest {
  return { id, serial: (current?.serial ?? 0) + 1 };
}

/**
 * A horizontal rail that brings what the creator just added into view. The creator's add tiles
 * stay fixed at the start of their rails (the owner's "pin the add tile at the start of the
 * rails", 2026-10-21), and a picture added joins the pictures beside them, past the edge once
 * they no longer fit, where only a counter said it had arrived.
 *
 * The add itself asks (`request`), as only it knows what was added: a rail's items also change
 * when a draft is restored or remixed, or when a model change sends references it held back or
 * holds back ones it sent, and none of those is an add. The item asked for is scrolled to the
 * rail's right edge when its own layout arrives, which on Fabric comes after the commit that
 * mounts it; if the creator is dragging the rail just then, their drag wins. A rail that mounts
 * after an ask (a tab switch) leaves it answered. `endInset` is the space the rail keeps after
 * its last item; `animated` is off under Reduce Motion.
 *
 * The scroll ref comes back on its own, beside the handlers: React Compiler treats whatever is
 * passed as a `ref` as a ref, so reading the handlers off the same object during render would
 * make it skip the component.
 */
export function useRailReveal(request: RailRevealRequest | null, endInset: number, animated: boolean) {
  const scrollRef = useRef<ScrollView>(null);
  const answered = useRef(request?.serial ?? 0);
  const pending = useRef<string | null>(null);
  const railWidth = useRef(0);
  const dragging = useRef(false);

  useLayoutEffect(() => {
    if (!request || request.serial <= answered.current) return;
    answered.current = request.serial;
    pending.current = request.id;
  }, [request]);

  return {
    scrollRef,
    /** For the rail's ScrollView: its width, and the creator's own drags. */
    scrollerProps: {
      onLayout: (event: LayoutChangeEvent) => {
        railWidth.current = event.nativeEvent.layout.width;
      },
      onScrollBeginDrag: () => {
        dragging.current = true;
      },
      onScrollEndDrag: () => {
        dragging.current = false;
      },
    },
    itemLayout: (id: string) => (event: LayoutChangeEvent) => {
      if (pending.current !== id) return;
      pending.current = null;
      if (dragging.current || railWidth.current === 0) return;
      const { x, width } = event.nativeEvent.layout;
      scrollRef.current?.scrollTo({ x: Math.max(0, x + width + endInset - railWidth.current), animated });
    },
  };
}
