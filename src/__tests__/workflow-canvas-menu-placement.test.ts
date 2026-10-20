import { describe, expect, it } from 'vitest';

import { placeMenuAtPointer } from '@/app/create-workflow/workflowCanvasUiUtils';

// The canvas's context menu, 260 x 220 as the pane's menu is, in a 390 x 844 phone
// window. tests/e2e/app-shell-short-pages.spec.ts draws it on the page.
const menu = { width: 260, height: 220 };
const bounds = { width: 390, height: 844 };

describe('placeMenuAtPointer', () => {
  it('opens right and down from the pointer where the menu fits there', () => {
    expect(placeMenuAtPointer({ pointer: { x: 40, y: 200 }, menu, bounds })).toEqual({ left: 40, top: 200 });
  });

  it('opens left of the pointer by the right edge and above it by the bottom, ending at the pointer', () => {
    expect(placeMenuAtPointer({ pointer: { x: 388, y: 742 }, menu, bounds })).toEqual({ left: 128, top: 522 });
  });

  it('keeps the margin inside the far edge when the menu fits on neither side of the pointer', () => {
    // 200 + 260 runs past 382, and 200 - 260 past 8.
    expect(placeMenuAtPointer({ pointer: { x: 200, y: 300 }, menu, bounds })).toEqual({ left: 122, top: 300 });
    expect(placeMenuAtPointer({ pointer: { x: 200, y: 300 }, menu, bounds, margin: 16 })).toEqual({ left: 114, top: 300 });
  });

  it('starts at the margin when the menu is larger than the window', () => {
    expect(placeMenuAtPointer({ pointer: { x: 120, y: 100 }, menu, bounds: { width: 240, height: 200 } }))
      .toEqual({ left: 8, top: 8 });
  });
});
