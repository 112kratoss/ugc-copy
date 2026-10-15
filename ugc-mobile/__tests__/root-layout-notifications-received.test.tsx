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

/** The alert types whose arrival reads the balance again, as the layout lists them. */
function balanceChangingAlerts() {
  const start = rootLayout.indexOf('const BALANCE_CHANGING_ALERTS: ReadonlySet<string> = new Set<MobileNotificationType>([');
  const end = rootLayout.indexOf(']);', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return [...rootLayout.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
}

const REFRESH_LINE = 'if (type && BALANCE_CHANGING_ALERTS.has(type)) void refreshProfile().catch(() => undefined);';

describe('an alert that moved the balance, landing while the app is in front', () => {
  // A run that fails with no creator watching it is refunded on the server, and
  // the balance on screen kept its cost: the creators refused Generate on it.
  // A purchase settled by a store webhook or the web's checkout, and a referral
  // reward, left the old balance on screen the same way (audit 03-4).
  it('reads the balance again', () => {
    const effect = receivedEffect();
    expect(effect).toContain(REFRESH_LINE);
    expect(effect).toContain('[queryClient, refreshProfile, user?.id]');
    expect(rootLayout).toContain('const { api, user, refreshProfile } = useAuth();');
  });

  it('for a refund, a purchase, restored purchases and either referral reward, and nothing else', () => {
    expect(balanceChangingAlerts()).toEqual([
      'generation_failed',
      'credits_purchased',
      'purchases_restored',
      'referral_reward_earned',
      'referral_reward_reversed',
    ]);
  });

  it('still refreshes the badge and the list for every alert, whatever its type', () => {
    const effect = receivedEffect();
    const refresh = effect.indexOf(REFRESH_LINE);
    expect(effect.indexOf('notificationBadgeQueryKey(user?.id)')).toBeGreaterThan(-1);
    expect(effect.indexOf('notificationBadgeQueryKey(user?.id)')).toBeLessThan(refresh);
    expect(effect.indexOf("['mobile-notifications', user?.id]")).toBeLessThan(refresh);
  });
});

describe('an alert landing while a seller has the app in front', () => {
  // A sale's push refreshed only the alerts; Your Sales and the payout balance
  // kept their old figures until the seller pulled them again (audit 03-6).
  it('refreshes Your Sales and the payout balance for every alert, whatever its type', () => {
    const effect = receivedEffect();
    const refresh = effect.indexOf(REFRESH_LINE);
    const sales = effect.indexOf("void queryClient.invalidateQueries({ queryKey: ['seller-dashboard-posts'] });");
    const payouts = effect.indexOf('void queryClient.invalidateQueries({ queryKey: [CREATOR_PAYOUTS_QUERY_KEY] });');

    expect(sales).toBeGreaterThan(-1);
    expect(payouts).toBeGreaterThan(-1);
    // Ahead of the typed balance refresh, so no alert type gates them.
    expect(sales).toBeLessThan(refresh);
    expect(payouts).toBeLessThan(refresh);
    expect(rootLayout).toContain("import { CREATOR_PAYOUTS_QUERY_KEY } from '@/lib/use-creator-payout-state';");
  });

  it('invalidates the key Your Sales reads its listings under', () => {
    const dashboard = readFileSync(path.resolve(__dirname, '..', 'app/seller-dashboard.tsx'), 'utf8');
    expect(dashboard).toContain("queryKey: ['seller-dashboard-posts', user?.id],");
  });
});
