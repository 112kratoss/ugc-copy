import { beforeEach, describe, expect, it } from 'vitest';

import { noteFollowChange, readFollowChanges } from '@/lib/follow-changes';

// The follows a viewer made in this tab, which a search page Back restores reads.

describe('follow changes of this tab', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('keeps each account’s changes by creator, the latest word for each', () => {
    expect(readFollowChanges('viewer-1')).toEqual({});
    noteFollowChange('viewer-1', 'creator-a', true);
    noteFollowChange('viewer-1', 'creator-b', true);
    noteFollowChange('viewer-1', 'creator-a', false);
    expect(readFollowChanges('viewer-1')).toEqual({ 'creator-a': false, 'creator-b': true });
  });

  it('says nothing to another account or to a visitor, and starts over when the account changes', () => {
    noteFollowChange('viewer-1', 'creator-a', true);
    expect(readFollowChanges('viewer-2')).toEqual({});
    expect(readFollowChanges(null)).toEqual({});
    // A visitor's press is no follow.
    noteFollowChange(null, 'creator-a', true);
    expect(readFollowChanges('viewer-1')).toEqual({ 'creator-a': true });
    noteFollowChange('viewer-2', 'creator-b', true);
    expect(readFollowChanges('viewer-2')).toEqual({ 'creator-b': true });
    expect(readFollowChanges('viewer-1')).toEqual({});
  });

  it('keeps the newest 200 and reads anything that is not its own shape as nothing', () => {
    for (let index = 0; index < 205; index += 1) noteFollowChange('viewer-1', `creator-${index}`, true);
    const kept = readFollowChanges('viewer-1');
    expect(Object.keys(kept)).toHaveLength(200);
    expect(kept['creator-0']).toBeUndefined();
    expect(kept['creator-204']).toBe(true);

    window.sessionStorage.setItem('magicbooklet:follow-changes:v1', '{"viewerId":"viewer-1","byId":["nope"]}');
    expect(readFollowChanges('viewer-1')).toEqual({});
    window.sessionStorage.setItem('magicbooklet:follow-changes:v1', 'not json');
    expect(readFollowChanges('viewer-1')).toEqual({});
    window.sessionStorage.setItem('magicbooklet:follow-changes:v1', '{"viewerId":"viewer-1","byId":{"creator-a":"yes","creator-b":false}}');
    expect(readFollowChanges('viewer-1')).toEqual({ 'creator-b': false });
  });
});
