import { useState, useSyncExternalStore } from 'react';
import type { LayoutChangeEvent, TextInputScrollEvent } from 'react-native';

/** What the @ menu is placed from: the prompt's card, its field inside the card, and how far the field's text is scrolled. */
export type PromptMentionGeometry = {
  cardHeight: number | null;
  field: { top: number; height: number; width: number } | null;
  scrollY: number;
};

export type PromptMentionAnchor = {
  /** For the prompt's card. */
  onCardLayout: (event: LayoutChangeEvent) => void;
  /** For the box the prompt's field fills inside the card (the field itself, or the view that clips it). */
  onFieldLayout: (event: LayoutChangeEvent) => void;
  /** For the prompt's `TextInput`. */
  onFieldScroll: (event: TextInputScrollEvent) => void;
  read: () => PromptMentionGeometry;
  subscribe: (listener: () => void) => () => void;
};

/**
 * Where a composer's prompt sits, kept outside React state. The composers re-render on every
 * keystroke already; a scroll of the prompt's text, which only the open @ menu needs, would add a
 * render of the whole composer per frame of the scroll. The menu, mounted only while a mention is
 * being typed, reads this through `usePromptMentionGeometry` and is the one thing that redraws.
 *
 * It holds no ref to the card: anything of it passed to a `ref` prop makes React Compiler take the
 * whole anchor for a ref, and every handler read off it in render for a ref read, and skip the
 * composer. The menu measures the card through the field's own ref instead.
 */
export function createPromptMentionAnchor(): PromptMentionAnchor {
  let geometry: PromptMentionGeometry = { cardHeight: null, field: null, scrollY: 0 };
  const listeners = new Set<() => void>();
  const update = (next: Partial<PromptMentionGeometry>) => {
    geometry = { ...geometry, ...next };
    listeners.forEach((listener) => listener());
  };
  return {
    onCardLayout: (event) => {
      const { height } = event.nativeEvent.layout;
      if (height !== geometry.cardHeight) update({ cardHeight: height });
    },
    onFieldLayout: (event) => {
      const { y, height, width } = event.nativeEvent.layout;
      const field = geometry.field;
      if (field?.top === y && field.height === height && field.width === width) return;
      update({ field: { top: y, height, width } });
    },
    onFieldScroll: (event) => {
      const y = event.nativeEvent.contentOffset.y;
      if (y !== geometry.scrollY) update({ scrollY: y });
    },
    read: () => geometry,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * One anchor per prompt field. `fieldKey` names the field the composer is drawing: when it changes
 * the field is a new one (the video tool's single prompt comes back after a story), which starts
 * unscrolled and reports no scroll to say so, so the anchor starts over with it.
 */
export function usePromptMentionAnchor(fieldKey: string | number | boolean = '') {
  const [held, setHeld] = useState(() => ({ fieldKey, anchor: createPromptMentionAnchor() }));
  if (held.fieldKey !== fieldKey) {
    const next = { fieldKey, anchor: createPromptMentionAnchor() };
    setHeld(next);
    return next.anchor;
  }
  return held.anchor;
}

export function usePromptMentionGeometry(anchor: PromptMentionAnchor) {
  return useSyncExternalStore(anchor.subscribe, anchor.read, anchor.read);
}
