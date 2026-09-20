# iOS viewer opening flash — 2026-09-20

## Cause

The supplied recording shows the selected landscape video, then an unrelated
superhero **image post**, then a black gap, then the selected video again around
6.4 seconds. The unrelated image has no active-slide caption or action rail.

The viewer opens immediately from a cached grid snapshot. Its 45-second stale
window can trigger a fresh ranked-feed request during opening. When the response
changes the order, the selected post's identity is preserved by `viewer-position`,
but its array index changes. FlatList paints the new data at its old native
offset. The alignment effect corrects that offset on a later animation frame;
virtualization must also move its rendered window. That exposes another row and
then an empty region. It is not another clip left in AVPlayer.

## Reproduction and verification

- iPhone 17 Pro simulator, iOS 26.4, local development bundle based on `8b6b5a53`.
- Ordinary openings with an unchanged ranking were clean.
- To exercise a changed ranking deterministically, temporary local diagnostics
  seeded the selected video's cached snapshot at index 3 and marked it stale.
  The real feed request returned that video at index 10, with the superhero image
  at index 3. No server data was modified.
- Before the fix: recording reproduced selected video → superhero image without
  controls → black → selected video. Logs showed active index 3 → 10 and a later
  native scroll event at offset 8740.
- After the fix, the same seeded snapshot and network response kept the active
  index at 3 while the refreshed list grew from 12 to 17 posts. Frame inspection
  through the refresh showed continuous selected content, without the unrelated
  image or black gap.
- Removed the seed and logging after the comparison. Verified normal opening
  and back-button dismissal in the simulator.
- Mobile typecheck and all 2,435 tests passed, including new regression cases for
  reordered snapshots, fresh objects, removal, and appended posts.

## Change and native API check

The mounted viewer keeps its opening order. Refreshes update retained post objects,
remove missing posts, and append new posts. A new opening uses the current source
order. The reconciliation runs before React commits the list, not in a later effect.

Checked the installed React Native native scroll implementation, `contentOffset`,
and `maintainVisibleContentPosition`. A late offset correction already caused the
flash; the latter explicitly warns against reordering scroll-view content. Keeping
the mounted reel stable avoids both the correction and the virtualization gap.
UIKit's Apple zoom transition and native players remain unchanged. This is shared
JS list behavior; it requires no new native module or OS version. Android receives
the same stable ordering, but this investigation's visual verification was on iOS.
