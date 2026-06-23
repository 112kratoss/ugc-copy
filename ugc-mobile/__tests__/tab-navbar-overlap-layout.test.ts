import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(path: string) {
  return readFileSync(join(__dirname, '..', path), 'utf8');
}

describe('tab navbar overlap layout', () => {
  it('lets the Feed list render behind the floating navbar', () => {
    const source = readSource('app/(tabs)/showcase.tsx');

    expect(source).not.toMatch(/marginBottom:\s*tabBarMetrics\.contentBottomOverlapPadding/);
    expect(source).toMatch(/paddingBottom:\s*tabBarMetrics\.contentBottomOverlapPadding \+ appTheme\.spacing\.section/);
  });

  it('lets the Create scroll view render behind the floating navbar', () => {
    const source = readSource('components/media-creation-screen.tsx');

    expect(source).not.toContain('contentBottomReserve');
    expect(source).toMatch(
      /const contentBottomPadding = insideTab\s*\?\s*tabBarMetrics\.contentBottomOverlapPadding \+ appTheme\.spacing\.section \+ \(showFloatingReviewBar \? FLOATING_REVIEW_BAR_HEIGHT \+ appTheme\.spacing\.gap : 0\)\s*:\s*bottomInset \+ 36;/
    );
    expect(source).toContain('bottom={tabBarMetrics.contentBottomPadding + 8}');
  });
});
