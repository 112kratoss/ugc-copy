import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(path: string) {
  return readFileSync(join(__dirname, '..', path), 'utf8');
}

describe('tab navbar overlap layout', () => {
  it('lets the last Home card clear the raised Create control', () => {
    const source = readSource('components/home-dashboard.tsx');

    expect(source).toMatch(/paddingBottom:\s*tabBarMetrics\.contentBottomPadding \+ 24/);
    expect(source).not.toMatch(/paddingBottom:\s*tabBarMetrics\.contentBottomOverlapPadding \+ 24/);
  });

  it('lets the Feed list render behind the floating navbar', () => {
    const source = readSource('app/(tabs)/showcase.tsx');

    expect(source).not.toMatch(/marginBottom:\s*tabBarMetrics\.contentBottomOverlapPadding/);
    expect(source).toMatch(/paddingBottom:\s*tabBarMetrics\.contentBottomOverlapPadding \+ appTheme\.spacing\.section/);
  });

  it('removes the floating navbar reserve from the focused Create workspace', () => {
    const source = readSource('components/media-creation-screen.tsx');

    expect(source).not.toContain('contentBottomReserve');
    // Both branches that can render pad off the safe-area inset alone, so a
    // reintroduced reserve would show up as a tab-bar metric added here. This
    // used to pin `contentBottomPadding`, which only the screen's unreachable
    // third branch consumed — the guard was reading dead code.
    expect(source).toMatch(/const contentBottom = bottomInset \+ 108;/);
    expect(source).toMatch(/const imageContentBottom = bottomInset \+ 108;/);
    expect(source).toContain('bottom={bottomInset + 8}');
    expect(source).not.toContain('getMagicTabBarMetrics');
  });

  it('hides the global tab bar on the creator route without changing its tree', () => {
    const source = readSource('app/(tabs)/_layout.tsx');

    // Hiding is MagicTabBar's job via the `hidden` prop so route fades keep one
    // stable navigation tree and do not reset the create menu's local state.
    expect(source).toContain(
      "hidden={props.state.routes[props.state.index]?.name === 'creator'}"
    );
    expect(source).not.toMatch(/\? null\s*:\s*<MagicTabBar/);
  });
});
