import { describe, expect, it } from 'vitest';

import { withViewerUnlockedRecipes } from '@/lib/viewer-unlocked-recipes';

// A creator page's first posts are the server's, drawn once for everyone: a buyer's recipes there
// read their price until their own recipes, read apart, mark them (sweep of 2026-11-17).
describe('withViewerUnlockedRecipes', () => {
  const free = { id: 'post-1', asset: { id: 'bundle-1', viewerHasUnlocked: false } };
  const paid = { id: 'post-2', asset: { id: 'bundle-2', viewerHasUnlocked: false } };
  const text = { id: 'post-3', asset: null };

  it("marks each recipe the viewer has as theirs, leaving every other item as it was", () => {
    const items = [free, paid, text];
    const marked = withViewerUnlockedRecipes(items, new Set(['bundle-2', 'elsewhere']));
    expect(marked.map((item) => item.asset?.viewerHasUnlocked ?? null)).toEqual([false, true, null]);
    expect(marked[0]).toBe(free);
    expect(marked[2]).toBe(text);
    expect(paid.asset.viewerHasUnlocked).toBe(false);
  });

  it('keeps the list itself when there is nothing to mark', () => {
    const items = [free, paid, text];
    expect(withViewerUnlockedRecipes(items, new Set())).toBe(items);
    expect(withViewerUnlockedRecipes(items, new Set(['elsewhere']))).toBe(items);
  });

  it('never takes a recipe away from a page read with the session', () => {
    const had = { id: 'post-4', asset: { id: 'bundle-4', viewerHasUnlocked: true } };
    const items = [had];
    expect(withViewerUnlockedRecipes(items, new Set(['bundle-1']))).toBe(items);
    expect(withViewerUnlockedRecipes(items, new Set(['bundle-4']))[0]).toBe(had);
  });
});
