import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Source pins for how the reel screen wires the libraries whose behaviour is
 * tested on its own (`use-showcase-lane-source`, `viewer-position`,
 * `viewer-session-items`, `reel-feed-events`). The screen is not rendered in
 * tests; these hold it to the calls those tests are about.
 */
const viewer = readFileSync('app/viewer.tsx', 'utf8');

/** The source from `from` through the first `to` after it. */
function slice(from: string, to: string) {
  const start = viewer.indexOf(from);
  if (start < 0) throw new Error(`app/viewer.tsx no longer contains: ${from}`);
  const end = viewer.indexOf(to, start);
  if (end < 0) throw new Error(`app/viewer.tsx has no "${to}" after: ${from}`);
  return viewer.slice(start, end + to.length);
}

describe('the reel reads the lane it was opened from', () => {
  it('reads a lane only when the route names one, and keeps the cold-link loader for the rest', () => {
    expect(viewer).toContain('const lane = useMemo(() => readViewerLane(source, laneParam), [laneParam, source]);');
    expect(viewer).toContain('const laneBacked = !libraryBacked && Boolean(lane);');
    expect(viewer).toContain('useShowcaseLaneSource({');
    expect(viewer).toContain('enabled: Boolean(source) && !gridBacked,');
    // The focus refresh that asked for a new session on every return.
    expect(viewer).toContain('if (!isFocused || gridBacked) return;');
  });

  it('pages on from its last post and closes the lane at its end', () => {
    expect(slice('onEndReached={grid?.hasNextPage ? () => {', '} : undefined}')).toContain('laneSource.fetchNextPage();');
    expect(viewer).toContain('ListFooterComponent={endSlide ? (');
    expect(viewer).toContain('onRetry={laneSource.retryNextPage}');
  });

  it("keeps a lane's posts when the lane's refresh leaves them out, and never refreshes it twice", () => {
    expect(viewer).toContain('reconcileViewerSessionItems(sessionItems.ordered, sourceItems, { keepMissing: laneBacked })');
    expect(slice('onSourceRefresh: () => {', '},')).toContain('if (!laneBacked) void sourceQuery.refetch();');
  });

  // Home and Explore key their lanes by the backend identity, a guest's
  // included (audit 04-3); the reel reads, edits and seeds from those same
  // lanes. Behaviour: `viewer-reel-actions.test.tsx`, "a guest's reel".
  it('keys the lanes it reads and edits by the identity, and keeps what is registered-only on the account', () => {
    expect(viewer).toContain('const { api, user, identityUserId } = useAuth();');
    expect(slice('const viewerFeedQueryKey = useMemo(', ');')).toContain('createShowcaseFeedViewerQueryKey(identityUserId)');
    expect(slice('const laneSource = useShowcaseLaneSource({', '});')).toContain('userId: identityUserId,');
    expect(viewer.match(
      /readCachedImmersiveSourceSnapshot\(queryClient, source, user\?\.id, initialId, routeFeedSessionId, creatorUsername, identityUserId\)/g
    )).toHaveLength(2);
    expect(viewer).not.toContain('createShowcaseFeedViewerQueryKey(user?.id)');
    expect(viewer).toContain("queryKey: ['profile', user?.id],");
    expect(viewer).toContain("['profile-saved-media', user?.id]");
  });

  it('comes back to the same lane after sign-in', () => {
    expect(slice('const returnPathFor = (item: ImmersivePreviewItem) => immersiveViewerReturnPath({', '});')).toContain('lane: laneParam,');
    // Every sign-in the reel starts goes through it.
    expect(viewer.match(/immersiveViewerReturnPath\(/g)).toHaveLength(1);
  });
});

describe('Not interested, Hide, Report and Block move the reader on', () => {
  it('chooses the next post from the list as it was, then removes', () => {
    const removal = slice('const removeFromReel = (target: ShowcaseFeedRemovalTarget) => {', '\n  };');
    const pick = removal.indexOf('pickViewerItemAfterRemoval(items, activeIndex,');
    const settle = removal.indexOf('if (next) setSavedPosition(initialViewerPosition(next));');
    const remove = removal.indexOf('removeViewerSessionItems(current.ordered, target)');
    expect(pick).toBeGreaterThan(-1);
    expect(settle).toBeGreaterThan(pick);
    expect(remove).toBeGreaterThan(settle);
    expect(removal).toContain('removeShowcaseFeedItemsFromInfiniteData(data, target)');
    // The old target, read against the list from before the removal.
    expect(viewer).not.toContain('Math.min(current, remainingItems.length - 1)');
  });

  it('uses it for a report as for a dismissal', () => {
    expect(slice('const dismissRecommendation = (', 'removal.restore();')).toContain('const removal = removeFromReel(target);');
    expect(slice('const takeOutReportedPost = (reported: ImmersivePreviewItem) => {', '};'))
      .toContain('removeFromReel({ postId: reported.showcasePostId })');
    expect(slice('const actionCallbacksFor = (item: ImmersivePreviewItem): ViewerActionCallbacks => ({', '\n  });'))
      .toContain('onReported: takeOutReportedPost,');
  });

  // A block used to close the reel (audit 02-4). Behaviour:
  // `viewer-reel-actions.test.tsx`, "Block user from the reel".
  it('uses it for a block, every post by the creator, and stays open on what is left', () => {
    const takeOut = slice('const takeOutBlockedCreator = (creatorId: string) => {', '\n  };');
    expect(takeOut).toContain('const removal = removeFromReel({ creatorId });');
    expect(takeOut).toContain('if (!removal.remaining) requestAnimationFrame(leaveViewer);');
    expect(slice('const actionCallbacksFor = (item: ImmersivePreviewItem): ViewerActionCallbacks => ({', '\n  });'))
      .toContain('onBlocked: takeOutBlockedCreator,');
    expect(viewer).not.toContain('onBlocked: () => zoom.dismiss()');
  });
});

describe("the ••• menu's Save and sign-in", () => {
  it("saves through the rail's optimistic Save, and comes back to the post from sign-in", () => {
    const callbacks = slice('const actionCallbacksFor = (item: ImmersivePreviewItem): ViewerActionCallbacks => ({', '\n  });');
    expect(callbacks).toContain('authReturnTo: returnPathFor(item),');
    expect(callbacks).toContain('onSave: (saved) => saveItem(saved),');
  });

  it('brings a signed-out heart, double-tap or owner action back to the post', () => {
    expect(slice('const saveItem: SaveItemHandler', 'return;\n    }'))
      .toContain("router.push({ pathname: '/auth', params: { returnTo: returnPathFor(item) } } as never);");
    expect(slice('const runOwnerAction = (action: string, item: ImmersivePreviewItem) => {', 'return;\n    }'))
      .toContain("router.push({ pathname: '/auth', params: { returnTo: returnPathFor(item) } } as never);");
    expect(viewer).not.toContain("router.push('/auth')");
    // A double-tap saves through the same handler, and Details signs in to this post too.
    expect(viewer).toContain("onSave(item, 'double-tap');");
    expect(slice('<PostDetailsPage', '/>')).toContain('authReturnTo={authReturnTo}');
  });
});

describe("the reel's feed events", () => {
  it('times the post on screen without restarting when a new session arrives', () => {
    const attention = slice("if (!initialPositionReady || !isFocused || onEndSlide || source !== 'showcase-feed'", ']);');
    const deps = attention.slice(attention.lastIndexOf('}, ['));
    expect(deps).toBe('}, [activeItem?.id, initialPositionReady, isFocused, onEndSlide, recordViewerFeedEvent, source]);');
    expect(attention).toContain('const leaveEvent = reelLeaveEventType(durationMs);');
    expect(attention).not.toContain("'quick_skip' : 'dwell'");
    // The submitter reads the session as it sends, so its identity holds.
    expect(slice('const submitViewerFeedEvent = useCallback((', ']);')).toMatch(/\}, \[api\]\);$/);
  });

  it("reports a post's resources opened from its Details card and its unlock sheet", () => {
    expect(viewer).toContain('const resourcesCardItem = detailsOpenForActive && activeItem?.details?.unlock ? activeItem : null;');
    expect(viewer).toContain('if (resourcesCardItem) recordResourceOpen(resourcesCardItem);');
    expect(viewer).toContain('if (unlockRemixSheetItem) recordResourceOpen(unlockRemixSheetItem);');
  });
});

describe('a reel with nothing to show', () => {
  it('says so in final words and offers a way on', () => {
    const empty = slice('if (!items.length) {\n    // Loaded, and nothing left to show', '</ViewerShell>');
    expect(empty).toContain('title="Nothing to show here"');
    expect(empty).toContain('<SecondaryButton label="Try again"');
    expect(viewer).not.toContain('or is still loading');
  });
});
