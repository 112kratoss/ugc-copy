import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(path: string) {
  return readFileSync(join(__dirname, '..', path), 'utf8');
}

describe('bottom-tab reselect scroll-to-top wiring', () => {
  it.each([
    ['Home', 'components/home-dashboard.tsx', 'feedRef'],
    ['Showcase', 'app/(tabs)/showcase.tsx', 'feedRef'],
    ['Profile', 'components/profile-dashboard.tsx', 'listRef'],
  ])('registers the %s FlashList with the tab reselect hook', (_, path, refName) => {
    const source = readSource(path);

    expect(source).toContain(`useScrollToTop(${refName})`);
    expect(source).toContain(`ref={${refName}}`);
  });

  it('registers the Alerts ScrollView with the tab reselect hook', () => {
    const source = readSource('app/(tabs)/studio.tsx');

    expect(source).toContain('useScrollToTop(scrollRef)');
    expect(source).toContain('ref={scrollRef}');
  });

  it('starts each Home feed lane from a fresh list origin', () => {
    const source = readSource('components/home-dashboard.tsx');

    expect(source).toContain('key={`home-feed-${activeChipId}`}');
    expect(source).toContain('maintainVisibleContentPosition={{ disabled: true }}');
  });
});
