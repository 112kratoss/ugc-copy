import { describe, expect, it } from 'vitest';

import {
  HOME_TOOL_SHORTCUTS,
  formatCompactCount,
  formatRelativeTime,
  formatUsdCents,
} from '../lib/home-view-model';

describe('home view model', () => {
  it('describes mobile workspace creator paths with routes', () => {
    expect(HOME_TOOL_SHORTCUTS.map(({ id, accent, href, previewVariant }) => ({ id, accent, href, previewVariant }))).toEqual([
      { id: 'image', accent: 'image', href: '/create/image', previewVariant: 'kingdom' },
      { id: 'video', accent: 'video', href: '/create/video', previewVariant: 'city' },
      { id: 'motion', accent: 'motion', href: '/create/motion', previewVariant: 'runner' },
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

  // 03-9: "$5" here and "$5.00" on the web for the same amount.
  it('prints dollars with their cents, as the web does', () => {
    expect(formatUsdCents(500)).toBe('$5.00');
    expect(formatUsdCents(10_000)).toBe('$100.00');
    expect(formatUsdCents(123_456)).toBe('$1,234.56');
    expect(formatUsdCents(5)).toBe('$0.05');
    expect(formatUsdCents(0)).toBe('$0.00');
    expect(formatUsdCents(null)).toBe('$0.00');
  });
});
