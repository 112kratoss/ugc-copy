import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import TabLoadingShell from '@/components/TabLoadingShell';

const TAB_LOADING_FILES = ['marketplace', 'create-workflow', 'profile', 'creations', 'create'];

describe('TabLoadingShell', () => {
  it('names the tab to screen readers only: no label chip or "Loading <tab>" title on screen (owner, 2026-11-14)', () => {
    const html = renderToString(<TabLoadingShell title="Studio" accent="coral" />);

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Loading Studio"');
    const visibleText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    expect(visibleText).toBe('');
    expect(html).toContain('animate-[skeleton-shimmer_1.5s_linear_infinite]');
  });

  it('is the loading state of the five tabs that use it, each named only by its title', () => {
    for (const folder of TAB_LOADING_FILES) {
      const source = readFileSync(join(process.cwd(), 'src/app', folder, 'loading.tsx'), 'utf8');
      expect(source, folder).toMatch(/<TabLoadingShell title="[^"]+"/);
      expect(source, folder).not.toContain('eyebrow');
    }
  });
});
