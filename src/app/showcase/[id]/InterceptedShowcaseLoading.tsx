import ShowcaseDetailOverlay from '@/app/showcase/[id]/ShowcaseDetailOverlay';
import ShowcaseDetailSkeleton from '@/app/showcase/[id]/ShowcaseDetailSkeleton';

/** Shared by both intercepting routes; see InterceptedShowcaseDetail. */
export default function InterceptedShowcaseLoading() {
  return (
    <ShowcaseDetailOverlay title="Loading post">
      <ShowcaseDetailSkeleton />
    </ShowcaseDetailOverlay>
  );
}
