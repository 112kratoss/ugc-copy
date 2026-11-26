import { requireAdminIdentity } from '@/lib/admin-auth';

import { AdminUpdatesConsole } from './AdminUpdatesConsole';

export const dynamic = 'force-dynamic';

/**
 * Help & Support's Updates and Roadmap, from the operator's side. The page
 * reads nothing itself: the console reads and changes everything through
 * `/api/admin/support-hub`, which checks the session again.
 */
export default async function AdminUpdatesPage() {
  await requireAdminIdentity();
  return <AdminUpdatesConsole />;
}
