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

  it('removes the floating navbar reserve from the focused Create workspace', () => {
    const source = readSource('components/media-creation-screen.tsx');

    expect(source).not.toContain('contentBottomReserve');
    expect(source).toMatch(
      /const contentBottomPadding = insideTab\s*\?\s*bottomInset \+ appTheme\.spacing\.section \+ \(showFloatingReviewBar \? FLOATING_REVIEW_BAR_HEIGHT \+ appTheme\.spacing\.gap : 0\)\s*:\s*bottomInset \+ 36;/
    );
    expect(source).toContain('bottom={bottomInset + 8}');
    expect(source).not.toContain('getMagicTabBarMetrics');
  });

  it('does not render the global tab bar on the creator route', () => {
    const source = readSource('app/(tabs)/_layout.tsx');

    expect(source).toContain("props.state.routes[props.state.index]?.name === 'creator'");
    expect(source).toMatch(/\? null\s*:\s*<MagicTabBar/);
  });
});
