import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

// On Android, text drawn before the display face has loaded keeps the system
// face until it is drawn again. Home's shelf title is drawn at launch, before
// `useFonts` has loaded the face, and was not drawn again when the answer had
// creations: it stayed in the thin system face (Pixel 9a emulator, 2026-10-25).
// The root layout says when the face is in, and AppText draws its display roles
// again then, for every title a screen draws at launch.

const mobileRoot = path.resolve(__dirname, '..');
const source = (file: string) => readFileSync(path.join(mobileRoot, file), 'utf8');

describe('display font ready', () => {
  it('tells each listener once, when the root layout marks the face loaded', async () => {
    vi.resetModules();
    const store = await import('@/lib/display-font-ready');
    const listener = vi.fn();
    const unsubscribe = store.subscribeDisplayFontLoaded(listener);

    expect(store.isDisplayFontLoaded()).toBe(false);
    store.markDisplayFontLoaded();
    store.markDisplayFontLoaded();

    expect(store.isDisplayFontLoaded()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('stops telling a listener that unsubscribed', async () => {
    vi.resetModules();
    const store = await import('@/lib/display-font-ready');
    const listener = vi.fn();
    store.subscribeDisplayFontLoaded(listener)();

    store.markDisplayFontLoaded();

    expect(listener).not.toHaveBeenCalled();
  });

  it('is marked by the root layout once useFonts reports the faces loaded', () => {
    expect(source('app/_layout.tsx')).toMatch(/if \(fontsLoaded\) markDisplayFontLoaded\(\);/);
  });

  it('makes AppText draw its display roles anew in the face, so every launch title gets it', () => {
    const ui = source('components/ui.tsx');
    expect(ui).toMatch(/const displayFontLoaded = useDisplayFontLoaded\(\);/);
    expect(ui).toMatch(/const faceKey = textRole\(variant\)\.fontFamily\s+\? \(displayFontLoaded \? 'display-face' : 'system-face'\)\s+: undefined;/);
    expect(ui).toMatch(/<Text\s+key=\{faceKey\}/);
    // The shelf's title is an AppText in a display role, with no key of its own.
    expect(source('components/home-shelf.tsx')).toMatch(/<AppText variant="cardTitle" heading numberOfLines=\{1\}>/);
  });
});
