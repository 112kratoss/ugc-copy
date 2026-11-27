import { notFound, permanentRedirect } from 'next/navigation';

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

  // An old resource address always names the same post: a permanent move (308).
  permanentRedirect(buildShowcaseDetailPath(postId, {
    from: 'unlocks',
    returnTo: '/marketplace',
    section: 'resources',
  }));
}
