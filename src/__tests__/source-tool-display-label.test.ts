import { describe, expect, it } from 'vitest';

import {
  APP_SOURCE_TOOL_DISPLAY_LABEL,
  FALLBACK_SOURCE_TOOLS,
  displaySourceToolLabel,
  isAppSourceToolLabel,
  normalizeSourceToolInputWithCatalog,
  toSourceToolFilterOptions,
} from '@/lib/source-tools';

// Posts made in the app store their tool as `magicbooklet`; people read the
// product's name (owner, 2026-11-05). The stored value must not change.
describe('the app tool’s shown name', () => {
  it('shows "Magic Booklet" for every spelling the app tool has been stored under', () => {
    for (const stored of ['magicbooklet', 'Magicbooklet', 'Magic Booklet', 'magic-booklet', ' MAGICBOOKLET ']) {
      expect(isAppSourceToolLabel(stored)).toBe(true);
      expect(displaySourceToolLabel(stored)).toBe(APP_SOURCE_TOOL_DISPLAY_LABEL);
    }
    expect(APP_SOURCE_TOOL_DISPLAY_LABEL).toBe('Magic Booklet');
  });

  it('leaves every other tool’s label as it is', () => {
    for (const label of ['Midjourney', 'CapCut', 'Booklet', 'magicbooklet pro', '']) {
      expect(isAppSourceToolLabel(label)).toBe(false);
      expect(displaySourceToolLabel(label)).toBe(label);
    }
    expect(isAppSourceToolLabel(null)).toBe(false);
  });

  it('keeps the filter chip’s slug, which the marketplace matches on', () => {
    const own = toSourceToolFilterOptions(FALLBACK_SOURCE_TOOLS).find((option) => option.slug === 'magicbooklet');
    expect(own).toEqual({ slug: 'magicbooklet', label: 'Magic Booklet' });
  });

  it('still stores the app tool as magicbooklet', () => {
    const stored = normalizeSourceToolInputWithCatalog(FALLBACK_SOURCE_TOOLS, { label: 'magicbooklet', slug: 'magicbooklet' });
    expect(JSON.stringify(stored)).not.toContain('Magic Booklet');
  });
});
