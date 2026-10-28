import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const globalsCss = fs.readFileSync(path.join(repoRoot, 'src/app/globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const reelViewer = fs.readFileSync(path.join(repoRoot, 'src/app/showcase/ShowcaseReelViewer.tsx'), 'utf8');

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

const tailwindZ = (className: string) => Number(/z-\[?(\d+)\]?/.exec(className)?.[1]);

// Review 4 findings #4 and #17: where a toast's close button lands decides
// what a press meant for the page beneath it does. For the saver notice a
// close counts as having read it.
describe('where toasts are drawn', () => {
  it("draws them below the app shell's top bar, never over its account button", () => {
    const viewport = rule('.ui-toast-viewport');
    expect(viewport.position).toBe('fixed');
    expect(viewport.top).toBe('calc(var(--app-shell-topbar-height) + 0.75rem)');
    // The bar is that tall, and drawn below the toasts' layer.
    expect(rule('.app-shell-header')['min-height']).toBe('var(--app-shell-topbar-height)');
    expect(Number(rule('.app-shell-header')['z-index'])).toBeLessThan(Number(viewport['z-index']));
  });

  it("draws them in the reel below its header, and under the header's layer, so its ⋯ menu is drawn over them", () => {
    const inDialog = rule('.ui-toast-viewport-in-dialog');
    // The reel's header is h-14: 3.5rem.
    expect(inDialog.top).toBe('calc(3.5rem + 0.75rem)');
    const headers = [...reelViewer.matchAll(/<header className="([^"]*)"/g)].map((match) => match[1]);
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) expect(header).toMatch(/\brelative z-20\b.*\bh-14\b/);

    const toastLayer = Number(inDialog['z-index']);
    const body = /<div className="relative (z-10) grid h-\[calc\(100dvh-3\.5rem\)\]/.exec(reelViewer)?.[1];
    expect(body).toBe('z-10');
    // Above the reel's body, below its header (and the ⋯ menu hanging from it).
    expect(toastLayer).toBeGreaterThan(tailwindZ('z-10'));
    expect(toastLayer).toBeLessThan(tailwindZ('z-20'));
    // The reel no longer draws a reference preview of its own over them: an
    // unlocked recipe is the post page's panel, its images inline (B-F1).
    expect(reelViewer).not.toMatch(/aria-label="Reference image preview"/);
  });
});
