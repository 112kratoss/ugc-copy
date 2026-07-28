import { redirect } from 'next/navigation';

import { AdminShell } from '@/app/admin/AdminShell';
import { authenticateAdminPage } from '@/lib/admin-auth';
import { countOpenModerationReports } from '@/lib/admin-moderation-service';
import { createServiceClient } from '@/lib/server-helpers';

export const dynamic = 'force-dynamic';

export default async function AdminConsoleLayout({ children }: { children: React.ReactNode }) {
  // src/proxy.ts already redirected unauthenticated traffic. This second check
  // is the actual boundary: it keeps the console closed even if the matcher is
  // ever misconfigured.
  const auth = await authenticateAdminPage();
  if (!auth.authenticated) {
    redirect('/admin/login');
  }

  // A failed count must not take down the whole console, so the badge degrades
  // to zero rather than throwing out of the layout.
  const openReports = await countOpenModerationReports(createServiceClient()).catch(() => 0);

  return (
    <AdminShell username={auth.identity.username} badges={{ moderation: openReports }}>
      {children}
    </AdminShell>
  );
}
