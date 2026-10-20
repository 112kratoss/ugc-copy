import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const globalsCss = fs
  .readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first rule for exactly this selector. */
function rule(selector: string) {
  const match = new RegExp(`(?:^|\\n)${selector.replace(/[.-]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(globalsCss);
  expect(match, selector).not.toBeNull();
  return Object.fromEntries(match![1]
    .split(';')
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .map((declaration) => {
      const colon = declaration.indexOf(':');
      return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
    }));
}

// On a phone 100vh is the window with its toolbar put away and 100dvh the window as it
// is. The app shell fills the window in dvh, so a short page fits it; a body of at least
// 100vh made the page the toolbar's height taller than the window while the toolbar
// showed, and every short page scrolled by it. A desktop browser has no such toolbar
// (the E2E harness's Chromium resolves vh, svh, lvh and dvh alike), so this reads the
// sheet instead.
describe('the body and the app shell fill the window as it is', () => {
  it.each(['body', '.app-shell-root', '.app-shell-main'])('%s is at least 100dvh, not 100vh', (selector) => {
    expect(rule(selector)['min-height']).toBe('100dvh');
  });
});
