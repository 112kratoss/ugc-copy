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

  it('hides the global tab bar on the creator route without unmounting it', () => {
    const source = readSource('app/(tabs)/_layout.tsx');

    // The bar must stay mounted on creator: remounting the Android BlurView
    // while the tab fade runs builds a cyclic RenderNode graph and hwui
    // crashes with a stack-overflow SIGSEGV. Hiding is MagicTabBar's job via
    // the `hidden` prop; a null branch here reintroduces the crash.
    expect(source).toContain(
      "hidden={props.state.routes[props.state.index]?.name === 'creator'}"
    );
    expect(source).not.toMatch(/\? null\s*:\s*<MagicTabBar/);
  });
});
