import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '..');

function readProjectFile(path: string) {
  return readFileSync(resolve(projectRoot, path), 'utf8');
}

describe('mobile startup performance contracts', () => {
  it('reports first render without invoking the unsafe Android interactivity bridge', () => {
    const layoutSource = readProjectFile('app/_layout.tsx');
    const packageJson = JSON.parse(readProjectFile('package.json'));

    expect(packageJson.dependencies['expo-observe']).toBe('~0.2.5');
    expect(layoutSource).toContain('AppMetricsRoot.wrap(RootLayout)');
    expect(layoutSource).toContain('STARTUP_VERSION_CHECK_FALLBACK_MS');
    expect(layoutSource).not.toContain('AppMetrics.markInteractive');
  });

  it('does not initialize RevenueCat from the global auth provider', () => {
    const authSource = readProjectFile('lib/auth.tsx');
    const pricingSource = readProjectFile('app/(tabs)/pricing.tsx');

    expect(authSource).not.toContain('configureIapForUser');
    expect(pricingSource).toContain('configureIapForUser');
  });

  it('unblocks navigation from the persisted session before profile credits finish refreshing', () => {
    const authSource = readProjectFile('lib/auth.tsx');
    const applySessionStart = authSource.indexOf('const applySessionState');
    const applySessionEnd = authSource.indexOf('const resetAuthState', applySessionStart);
    const applySessionSource = authSource.slice(applySessionStart, applySessionEnd);
    const hydrationEffectStart = authSource.indexOf('supabase.auth.onAuthStateChange');
    const hydrationStart = authSource.indexOf('const latestSession = data.session ?? null;', hydrationEffectStart);
    const hydrationEnd = authSource.indexOf('} catch (error)', hydrationStart);
    const hydrationSource = authSource.slice(hydrationStart, hydrationEnd);

    expect(applySessionSource).toContain('setIsLoading(false)');
    expect(hydrationSource.indexOf('applySessionState(latestSession)'))
      .toBeLessThan(hydrationSource.indexOf('refreshProfileForUser(latestSession.user.id)'));
    expect(authSource).toContain('profileRefreshRef.current');
    expect(authSource).toContain('existing?.userId === userId && existing.version === version');
  });

  it('does not fetch seller history until a hidden side menu is opened', () => {
    const homeSource = readProjectFile('components/home-dashboard.tsx');
    const workspaceMenuSource = readProjectFile('components/workspace-side-menu-gesture-layer.tsx');

    expect(homeSource).toContain("queryKey: ['owner-posts-sales-summary', user?.id]");
    expect(homeSource).toContain('enabled: Boolean(user && menuVisible)');
    expect(workspaceMenuSource).toContain("queryKey: ['owner-posts-sales-summary', user?.id]");
    expect(workspaceMenuSource).toContain('enabled: Boolean(user && menuVisible)');
  });
});
