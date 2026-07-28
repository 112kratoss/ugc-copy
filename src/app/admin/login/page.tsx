import { Suspense } from 'react';
import { redirect } from 'next/navigation';

import { authenticateAdminPage } from '@/lib/admin-auth';
import { resolveAdminConfig } from '@/lib/admin-identity';
import { Surface, Text } from '@/app/components/DesignSystem';

import { AdminLoginForm } from './AdminLoginForm';

export const dynamic = 'force-dynamic';

export default async function AdminLoginPage() {
  const auth = await authenticateAdminPage();
  if (auth.authenticated) {
    redirect('/admin');
  }

  const config = resolveAdminConfig();

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--ui-bg-page)] px-5 py-12">
      {config.configured ? (
        <Suspense fallback={null}>
          <AdminLoginForm />
        </Suspense>
      ) : (
        <Surface variant="panel" padding="lg" className="w-full max-w-md">
          <Text as="h1" variant="cardTitle">Admin access is not configured</Text>
          <Text variant="bodySm" className="mt-2">
            Run <code className="font-mono text-[var(--ui-text-secondary)]">npm run admin:credentials</code> and
            add the printed variables to this environment, then reload.
          </Text>
          <ul className="mt-4 flex flex-col gap-1.5">
            {config.issues.map((issue) => (
              <li key={issue}>
                <Text as="span" variant="bodySm" className="text-[var(--ui-accent-danger)]">
                  {issue}
                </Text>
              </li>
            ))}
          </ul>
        </Surface>
      )}
    </div>
  );
}
