import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Source assertions, as `hig-alerts-screen.test.ts` pins the badge refresh in
 * this same effect: the root layout cannot be mounted without the whole native
 * chain behind it. `notifications.test.ts` holds the subscription to handing
 * over each alert's type; this holds the layout to acting on it.
 */
const rootLayout = readFileSync(path.resolve(__dirname, '..', 'app/_layout.tsx'), 'utf8');

function receivedEffect() {
  const start = rootLayout.indexOf('useEffect(() => subscribeToNotificationsReceived(');
  const end = rootLayout.indexOf(']);', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return rootLayout.slice(start, end + 3);
}

describe('a failed run’s alert, landing while the app is in front', () => {
  // A run that fails with no creator watching it is refunded on the server, and
  // the balance on screen kept its cost: the creators refused Generate on it.
  it('reads the balance again', () => {
    const effect = receivedEffect();
    expect(effect).toContain("if (type === 'generation_failed') void refreshProfile().catch(() => undefined);");
    expect(effect).toContain('[queryClient, refreshProfile, user?.id]');
    expect(rootLayout).toContain('const { api, user, refreshProfile } = useAuth();');
  });

  it('still refreshes the badge and the list for every alert, whatever its type', () => {
    const effect = receivedEffect();
    const refresh = effect.indexOf("if (type === 'generation_failed')");
    expect(effect.indexOf('notificationBadgeQueryKey(user?.id)')).toBeGreaterThan(-1);
    expect(effect.indexOf('notificationBadgeQueryKey(user?.id)')).toBeLessThan(refresh);
    expect(effect.indexOf("['mobile-notifications', user?.id]")).toBeLessThan(refresh);
  });
});
