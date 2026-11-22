import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(path: string) {
  return readFileSync(join(__dirname, '..', path), 'utf8');
}

/**
 * The list takes the ref itself, or a callback ref that fills it first thing
 * (the pull to refresh reads the same list's scroll view,
 * components/refresh-book.tsx) and is given to the list.
 */
function expectListFillsRef(source: string, refName: string, param: string) {
  if (source.includes(`ref={${refName}}`)) return;
  const callback = new RegExp(
    `const (\\w+) = useCallback\\(\\(${param}: [^)]*\\) => \\{\\s*${refName}\\.current = ${param};`,
  ).exec(source);
  expect(callback, `a callback ref that sets ${refName}.current`).not.toBeNull();
  expect(source).toContain(`ref={${callback![1]}}`);
}

describe('bottom-tab reselect scroll-to-top wiring', () => {
  it.each([
    ['Home', 'components/home-dashboard.tsx', 'feedRef'],
    ['Showcase', 'app/(tabs)/showcase.tsx', 'feedRef'],
    ['Profile', 'components/profile-dashboard.tsx', 'listRef'],
  ])('registers the %s FlashList with the tab reselect hook', (_, path, refName) => {
    const source = readSource(path);

    expect(source).toContain(`useScrollToTop(${refName})`);
    expectListFillsRef(source, refName, 'list');
  });

  it('registers the Alerts ScrollView with the tab reselect hook', () => {
    const source = readSource('app/(tabs)/studio.tsx');

    expect(source).toContain('useScrollToTop(scrollRef)');
    expectListFillsRef(source, 'scrollRef', 'scrollView');
  });

  it('starts each Home feed lane from a fresh list origin', () => {
    const source = readSource('components/home-dashboard.tsx');

    expect(source).toContain('key={`home-feed-${activeChipId}`}');
    // Ranked lanes start at the top; Recent keeps its place as new posts land
    // (since 2026-09-21). Until the shelf replaced the header rail, the rail's
    // own list carried the `disabled: true` this line used to look for.
    expect(source).toContain("maintainVisibleContentPosition={{ disabled: activeChip.filters.sort !== 'recent' }}");
  });
});
