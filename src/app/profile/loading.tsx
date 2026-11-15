import ReelHostMark from '@/components/ReelHostMark';
import TabLoadingShell from '@/components/TabLoadingShell';

export default function ProfileLoading() {
  return (
    <>
      {/* The profile opens a `?post=` in its reel once loaded: the reel's stage stays meanwhile. */}
      <ReelHostMark />
      <TabLoadingShell title="Profile" accent="coral" />
    </>
  );
}
