import { describe, expect, it } from 'vitest';

import { formatCompactCount } from '@/lib/home-view-model';
import { buildReelCaption, getRailCountLabel, getReelFollowTarget } from '@/lib/reel-overlay-view-model';

describe('buildReelCaption', () => {
  it('keeps a caption that says something the title did not', () => {
    expect(buildReelCaption({ title: 'Moody Bathroom Portrait Study', displayText: 'A soft-lit bathroom portrait reference.' })).toEqual({
      title: 'Moody Bathroom Portrait Study',
      caption: 'A soft-lit bathroom portrait reference.',
    });
  });

  it('drops a caption that only repeats the title', () => {
    expect(buildReelCaption({ title: 'reavder', displayText: 'reavder' })).toEqual({ title: 'reavder', caption: '' });
    expect(buildReelCaption({ title: 'Reavder ', displayText: '  reavder' })).toEqual({ title: 'Reavder', caption: '' });
  });

  it('lets the caption lead when the title is only a placeholder', () => {
    expect(buildReelCaption({ title: 'Untitled Creation', displayText: 'A hyperrealistic cinematic portrait.' }))
      .toEqual({ title: '', caption: 'A hyperrealistic cinematic portrait.' });
    expect(buildReelCaption({ title: '', displayText: 'Community post' })).toEqual({ title: '', caption: '' });
  });
});

describe('getReelFollowTarget', () => {
  it('offers to follow another creator on a showcase post', () => {
    expect(getReelFollowTarget({ sourceType: 'showcase', creatorId: 'creator-1' }, 'viewer-1')).toEqual({ creatorId: 'creator-1' });
    expect(getReelFollowTarget({ sourceType: 'showcase', creatorId: 'creator-1' }, null)).toEqual({ creatorId: 'creator-1' });
  });

  it('never offers to follow yourself or your own work', () => {
    expect(getReelFollowTarget({ sourceType: 'showcase', creatorId: 'viewer-1' }, 'viewer-1')).toBeNull();
    expect(getReelFollowTarget({ sourceType: 'generation', creatorId: 'viewer-1' }, 'viewer-1')).toBeNull();
    expect(getReelFollowTarget({ sourceType: 'owner-post', creatorId: 'viewer-1' }, 'viewer-1')).toBeNull();
  });

  it('has nobody to follow without a creator id', () => {
    expect(getReelFollowTarget({ sourceType: 'showcase', creatorId: null }, 'viewer-1')).toBeNull();
    expect(getReelFollowTarget({ sourceType: 'showcase', creatorId: '  ' }, 'viewer-1')).toBeNull();
  });
});

describe('getRailCountLabel', () => {
  it('shows a count only once there is one', () => {
    expect(getRailCountLabel(0, formatCompactCount)).toBeNull();
    expect(getRailCountLabel(null, formatCompactCount)).toBeNull();
    expect(getRailCountLabel(4, formatCompactCount)).toBe('4');
    expect(getRailCountLabel(1858, formatCompactCount)).toBe('1.9K');
  });
});
