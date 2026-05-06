import { notFound, redirect } from 'next/navigation';

import { resolvePostIdForResourceIdentifier } from '@/lib/post-resource-bundles-server';
import { buildShowcaseDetailPath } from '@/lib/share';

interface MarketplaceAssetPageProps {
  params: Promise<{ assetId: string }>;
}

export default async function MarketplaceAssetPage({ params }: MarketplaceAssetPageProps) {
  const { assetId } = await params;
  const postId = await resolvePostIdForResourceIdentifier(assetId);

  if (!postId) {
    notFound();
  }

  redirect(buildShowcaseDetailPath(postId, {
    from: 'unlocks',
    returnTo: '/marketplace',
    section: 'resources',
  }));
}
