import { describe, expect, it } from 'vitest';

import {
  HOME_TOOL_SHORTCUTS,
  formatCompactCount,
  formatRelativeTime,
  formatUsdCents,
  getOwnerPostSalesSummary,
} from '../lib/home-view-model';

describe('home view model', () => {
  it('describes mobile workspace creator paths with routes and the workflow teaser', () => {
    expect(HOME_TOOL_SHORTCUTS.map(({ id, accent, href, badge, previewVariant }) => ({ id, accent, href, badge, previewVariant }))).toEqual([
      { id: 'image', accent: 'image', href: '/create/image', badge: undefined, previewVariant: 'kingdom' },
      { id: 'video', accent: 'video', href: '/create/video', badge: undefined, previewVariant: 'city' },
      { id: 'motion', accent: 'motion', href: '/create/motion', badge: undefined, previewVariant: 'runner' },
      { id: 'workflow', accent: 'workflow', href: null, badge: 'Soon', previewVariant: null },
    ]);
  });

  it('formats compact counts and relative times for dashboard cards', () => {
    const now = new Date('2026-05-13T12:00:00.000Z');

    expect(formatCompactCount(96)).toBe('96');
    expect(formatCompactCount(1200)).toBe('1.2K');
    expect(formatCompactCount(1_000_000)).toBe('1M');
    expect(formatRelativeTime('2026-05-13T11:50:00.000Z', now)).toBe('10m ago');
    expect(formatRelativeTime('2026-05-12T10:00:00.000Z', now)).toBe('1d ago');
    expect(formatUsdCents(4280)).toBe('$42.80');
  });

  it('summarizes seller post earnings for the side menu wallet', () => {
    expect(getOwnerPostSalesSummary([
      {
        id: 'post-1',
        title: 'Portal pack',
        createdAt: '2026-05-13T10:00:00.000Z',
        visibility: 'public',
        mediaUrl: null,
        mediaKind: 'image',
        bundle: {
          id: 'bundle-1',
          accessMode: 'paid',
          status: 'published',
          priceUsdCents: 1200,
          salesCount: 2,
          earningsUsdCents: 2400,
          resourceKinds: ['prompt'],
        },
      },
      {
        id: 'post-2',
        title: 'Free notes',
        createdAt: '2026-05-13T11:00:00.000Z',
        visibility: 'public',
        mediaUrl: null,
        mediaKind: null,
        bundle: null,
      },
    ])).toEqual({ salesCount: 2, earningsUsdCents: 2400 });
  });

});
