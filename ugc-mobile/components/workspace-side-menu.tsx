import { useQuery } from '@tanstack/react-query';
import { memo } from 'react';

import { HomeSideMenu } from '@/components/home-side-menu';
import { useAuth } from '@/lib/auth';
import { useSideMenuHost, useSideMenuHostOpen } from '@/lib/side-menu-host';

/**
 * The workspace side menu with what it shows: the account, the balance and the
 * tracked earnings. The profile is read while the menu is up; Home keeps it
 * warm under the same key, so the menu opened from Home has it at once.
 */
export function WorkspaceSideMenu({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { api, credits, signOut, user } = useAuth();
  const profileQuery = useQuery({
    queryKey: ['profile', user?.id],
    enabled: Boolean(user && visible),
    queryFn: () => api.getProfile(),
    staleTime: 1000 * 60 * 5,
  });

  // The seller total rides on the profile; unknown until the profile has answered.
  const totalSalesUsdCents = profileQuery.data?.sales?.earningsUsdCents ?? null;

  return (
    <HomeSideMenu
      visible={visible}
      onClose={onClose}
      user={user}
      profile={profileQuery.data}
      credits={credits}
      totalSalesUsdCents={totalSalesUsdCents}
      onSignOut={signOut}
    />
  );
}

/**
 * The menu as the tab bar draws it (`lib/side-menu-host.ts` says why it is
 * drawn there). Memoised with no props, so the tab bar's own renders, one per
 * tab switch, leave it alone: a menu leaving over the new tab is not rendered
 * again by the switch it started. Nothing without the tabs layout's host.
 */
export const TabBarSideMenu = memo(function TabBarSideMenu() {
  const store = useSideMenuHost();
  const visible = useSideMenuHostOpen(store);
  if (!store) return null;
  return <WorkspaceSideMenu visible={visible} onClose={store.close} />;
});
