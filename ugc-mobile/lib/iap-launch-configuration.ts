/**
 * RevenueCat set up for the current identity once after launch, and again when the identity
 * changes (audit 2026-11-27, finding 3). Until then it was set up only when the Credits tab
 * mounted, so a purchase the store approved later (a Play pending payment, Ask to Buy) or one
 * interrupted reached RevenueCat, and through its webhook the account, only once that tab opened
 * again. Configuring is what lets the SDK finish those transactions.
 *
 * Kept out of sign-in and the first frames for startup speed (`startup-performance.test.ts`): the
 * root layout asks for it only after the shell is ready and the launch's interactions are done
 * (`use-iap-launch-configuration.ts`).
 */

/** How long after the shell is ready the launch sets RevenueCat up. */
export const IAP_LAUNCH_CONFIGURE_DELAY_MS = 4_000;

type Configure = (userId: string, os: string) => Promise<boolean>;

export function createIapLaunchConfigurator({ configure, os }: { configure: Configure; os: string }) {
  let configuredFor: string | null = null;

  return {
    /** Sets RevenueCat up for this identity, once. Never throws; a failure is tried again next time. */
    async sync(identityUserId: string | null): Promise<void> {
      if (!identityUserId || (os !== 'ios' && os !== 'android')) return;
      if (configuredFor === identityUserId) return;
      try {
        if (await configure(identityUserId, os)) configuredFor = identityUserId;
      } catch {
        // The Credits tab sets it up again, and says so if it cannot.
      }
    },
  };
}
