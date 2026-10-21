import { useLayoutEffect, useRef } from 'react';
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, ScrollView } from 'react-native';

/** Asks a rail to bring one item into view: every ask is a new object. */
export type RailRevealRequest = { id: string };

/**
 * How long a drag or a fling the rail saw begin holds reveals back without being seen to end:
 * Android reports no end for a drag the system cancels (a back gesture, the screen going off).
 */
export const RAIL_GESTURE_HOLD_MS = 4000;

type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;

/**
 * A horizontal rail that brings what the creator just added into view. The creator's add tiles
 * stay fixed at the start of their rails (the owner's "pin the add tile at the start of the
 * rails", 2026-10-21), and a picture added joins the pictures beside them, past the edge once
 * they no longer fit, where only a counter said it had arrived.
 *
 * The add itself asks (`request`), as only it knows what was added: a rail's items also change
 * when a draft is restored or remixed, or when a model change sends references it held back or
 * holds back ones it sent, and none of those is an add. An ask counts only in the commit that
 * brings it and only for an item then on this rail (`railIds`): one the model holds back stays
 * answered, so a later model change that sends it cannot move the rail.
 *
 * The item asked for is brought into view when its own layout arrives, which on Fabric comes
 * after the commit that mounts it, by the least scroll: none when it is already in view. The
 * creator's own scroll wins: a reveal that lands during a drag or the coast after a fling is
 * dropped. A rail that mounts after an ask (a tab switch) leaves it answered. `endInset` is the
 * space the rail keeps after its last item; `animated` is off under Reduce Motion.
 *
 * The scroll ref comes back on its own, beside the handlers: React Compiler treats whatever is
 * passed as a `ref` as a ref, so reading the handlers off the same object during render would
 * make it skip the component.
 */
export function useRailReveal(
  request: RailRevealRequest | null,
  railIds: readonly string[],
  endInset: number,
  animated: boolean,
) {
  const scrollRef = useRef<ScrollView>(null);
  const answered = useRef(request);
  const pending = useRef<string | null>(null);
  const railWidth = useRef(0);
  const offset = useRef(0);
  const gestureSince = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (request === answered.current) return;
    answered.current = request;
    pending.current = request && railIds.includes(request.id) ? request.id : null;
  }, [request, railIds]);

  const gestureBegins = () => {
    gestureSince.current = Date.now();
  };
  const gestureEnds = (event: ScrollEvent) => {
    offset.current = event.nativeEvent.contentOffset.x;
    gestureSince.current = null;
  };

  return {
    scrollRef,
    /** For the rail's ScrollView: its width and offset, and the creator's own drags and flings. */
    scrollerProps: {
      onLayout: (event: LayoutChangeEvent) => {
        railWidth.current = event.nativeEvent.layout.width;
      },
      onScroll: (event: ScrollEvent) => {
        offset.current = event.nativeEvent.contentOffset.x;
      },
      scrollEventThrottle: 64,
      onScrollBeginDrag: gestureBegins,
      onScrollEndDrag: gestureEnds,
      onMomentumScrollBegin: gestureBegins,
      onMomentumScrollEnd: gestureEnds,
    },
    itemLayout: (id: string) => (event: LayoutChangeEvent) => {
      if (pending.current !== id) return;
      pending.current = null;
      const since = gestureSince.current;
      if ((since !== null && Date.now() - since < RAIL_GESTURE_HOLD_MS) || railWidth.current === 0) return;
      const { x, width } = event.nativeEvent.layout;
      const start = offset.current;
      const end = start + railWidth.current;
      let target: number;
      if (x + width + endInset > end) target = x + width + endInset - railWidth.current;
      else if (x < start) target = x;
      else return;
      target = Math.max(0, target);
      offset.current = target;
      scrollRef.current?.scrollTo({ x: target, animated });
    },
  };
}
