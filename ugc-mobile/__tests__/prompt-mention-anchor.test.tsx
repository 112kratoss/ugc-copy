import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { createPromptMentionAnchor, usePromptMentionAnchor, type PromptMentionAnchor } from '../lib/prompt-mention-anchor';

const layout = (values: { x?: number; y?: number; width?: number; height?: number }) => ({
  nativeEvent: { layout: { x: 0, y: 0, width: 0, height: 0, ...values } },
}) as never;
const scroll = (y: number) => ({ nativeEvent: { contentOffset: { x: 0, y } } }) as never;

describe('createPromptMentionAnchor', () => {
  it('keeps the card, the field and the field’s scroll, and tells its listeners only of a change', () => {
    const anchor = createPromptMentionAnchor();
    const listener = vi.fn();
    const stop = anchor.subscribe(listener);
    expect(anchor.read()).toEqual({ cardHeight: null, field: null, scrollY: 0 });

    anchor.onCardLayout(layout({ height: 260 }));
    anchor.onFieldLayout(layout({ y: 37, width: 360, height: 190 }));
    anchor.onFieldScroll(scroll(92));
    expect(anchor.read()).toEqual({ cardHeight: 260, field: { top: 37, height: 190, width: 360 }, scrollY: 92 });
    expect(listener).toHaveBeenCalledTimes(3);

    const before = anchor.read();
    anchor.onCardLayout(layout({ height: 260 }));
    anchor.onFieldLayout(layout({ y: 37, width: 360, height: 190 }));
    anchor.onFieldScroll(scroll(92));
    expect(listener).toHaveBeenCalledTimes(3);
    // The same snapshot while nothing changed, as useSyncExternalStore needs.
    expect(anchor.read()).toBe(before);

    stop();
    anchor.onFieldScroll(scroll(0));
    expect(listener).toHaveBeenCalledTimes(3);
  });
});

describe('usePromptMentionAnchor', () => {
  // The video tool's single prompt comes back after a story as a new field, unscrolled and
  // reporting no scroll: an anchor kept from the old field would place the menu by its scroll.
  it('starts a new anchor when the field it is for is drawn anew, and keeps it otherwise', () => {
    const seen: PromptMentionAnchor[] = [];
    function Probe({ fieldKey }: { fieldKey: boolean }) {
      seen.push(usePromptMentionAnchor(fieldKey));
      return null;
    }
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<Probe fieldKey={false} />);
    });
    seen[0].onFieldScroll(scroll(100));
    renderer.act(() => tree!.update(<Probe fieldKey={false} />));
    expect(seen.at(-1)).toBe(seen[0]);

    renderer.act(() => tree!.update(<Probe fieldKey />));
    renderer.act(() => tree!.update(<Probe fieldKey={false} />));
    const fresh = seen.at(-1)!;
    expect(fresh).not.toBe(seen[0]);
    expect(fresh.read().scrollY).toBe(0);
    renderer.act(() => tree!.unmount());
  });
});
