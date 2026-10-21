import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { addedRailIds, useRailReveal } from '../lib/use-rail-reveal';

// A rail whose add tile stays fixed at its start: what the creator adds lands at the end of the
// pictures beside it, past the edge once they no longer fit, so the rail brings it into view
// (the owner's "pin the add tile at the start of the rails", 2026-10-21).
describe('addedRailIds', () => {
  it('names what joined the rail when nothing left it', () => {
    expect(addedRailIds(['a', 'b'], ['a', 'b', 'c', 'd'])).toEqual(['c', 'd']);
    // An image joins before the rail's clips.
    expect(addedRailIds(['image-1', 'clip-1'], ['image-1', 'image-2', 'clip-1'])).toEqual(['image-2']);
  });

  it('names nothing on the first look, into an empty rail, or when the rail was replaced or only lost a picture', () => {
    expect(addedRailIds(null, ['a', 'b'])).toEqual([]);
    // The saved draft is read after the screen opens, into a rail that showed nothing yet.
    expect(addedRailIds([], ['a', 'b', 'c', 'd', 'e'])).toEqual([]);
    // A remix or a restored draft brings its own pictures.
    expect(addedRailIds(['a', 'b'], ['c', 'd'])).toEqual([]);
    expect(addedRailIds(['a', 'b'], ['b', 'c'])).toEqual([]);
    expect(addedRailIds(['a', 'b'], ['a'])).toEqual([]);
    expect(addedRailIds(['a'], ['a'])).toEqual([]);
  });
});

describe('useRailReveal', () => {
  type Reveal = ReturnType<typeof useRailReveal>;
  const layout = (x: number, width: number) => ({ nativeEvent: { layout: { x, y: 0, width, height: 72 } } }) as never;

  function mount(ids: string[], scrollTo = vi.fn()) {
    let reveal!: Reveal;
    function Probe({ items }: { items: string[] }) {
      reveal = useRailReveal(items, 16);
      return null;
    }
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<Probe items={ids} />); });
    Object.assign(reveal.scrollRef, { current: { scrollTo } });
    return {
      scrollTo,
      get reveal() { return reveal; },
      update: (next: string[]) => renderer.act(() => { tree.update(<Probe items={next} />); }),
    };
  }

  it('scrolls the newest picture to the rail’s end once its place is known', () => {
    const rail = mount(['a', 'b', 'c']);
    rail.reveal.onRailLayout(layout(0, 300));
    rail.reveal.itemLayout('a')(layout(0, 72));
    rail.reveal.itemLayout('b')(layout(81, 72));
    rail.reveal.itemLayout('c')(layout(162, 72));
    expect(rail.scrollTo).not.toHaveBeenCalled();

    rail.update(['a', 'b', 'c', 'd', 'e']);
    rail.reveal.itemLayout('d')(layout(243, 72));
    expect(rail.scrollTo).not.toHaveBeenCalled();
    rail.reveal.itemLayout('e')(layout(324, 72));
    // Its right edge, and the rail's end inset, at the rail's right edge.
    expect(rail.scrollTo).toHaveBeenCalledWith({ x: 324 + 72 + 16 - 300, animated: true });
    expect(rail.scrollTo).toHaveBeenCalledTimes(1);

    // Laid out again later (a rename, a scroll), it is not chased.
    rail.reveal.itemLayout('e')(layout(324, 72));
    expect(rail.scrollTo).toHaveBeenCalledTimes(1);
  });

  it('scrolls at once when the picture was laid out before the rail saw it join, and never to the left of the start', () => {
    const rail = mount(['a']);
    rail.reveal.onRailLayout(layout(0, 300));
    rail.reveal.itemLayout('a')(layout(0, 72));
    rail.reveal.itemLayout('b')(layout(81, 72));
    rail.update(['a', 'b']);
    expect(rail.scrollTo).toHaveBeenCalledWith({ x: 0, animated: true });
  });

  it('leaves a rail that was restored or replaced where it is', () => {
    const rail = mount(['a', 'b']);
    rail.reveal.onRailLayout(layout(0, 300));
    rail.update(['c', 'd', 'e', 'f']);
    rail.reveal.itemLayout('f')(layout(243, 72));
    expect(rail.scrollTo).not.toHaveBeenCalled();
  });
});
