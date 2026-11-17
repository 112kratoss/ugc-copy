import type { Metadata } from 'next';

import { RequireAuth } from '@/components/RouteAuthBoundary';
import TemplateCatalogClient from '@/components/templates/TemplateCatalogClient';
import { loadTemplatesLive } from '@/lib/live-media-templates';

export const metadata: Metadata = {
  title: 'My Templates',
};

/**
 * The owner's templates. Whether the public catalog lists one is read here, from the cache
 * the creators share, so the owner's "Browse templates" never opens an empty catalog.
 */
export default async function MyTemplatesPage() {
  const templatesLive = await loadTemplatesLive();
  return (
    <RequireAuth returnTo="/templates/mine">
      <TemplateCatalogClient mode="owner" templatesLive={templatesLive} />
    </RequireAuth>
  );
}
