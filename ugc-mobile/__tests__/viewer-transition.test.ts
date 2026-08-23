import { describe, expect, it } from 'vitest';

import {
  getContainedRect,
  measureViewerOrigin,
  setViewerOrigin,
  takeViewerOrigin,
} from '../lib/viewer-transition';

const rect = { x: 10, y: 20, width: 100, height: 140 };

describe('viewer transition origin hand-off', () => {
  it('hands the origin to the matching item exactly once', () => {
    setViewerOrigin({ id: 'post-1', rect, previewUrl: 'u', radius: 12, recordedAt: 1000 });

    expect(takeViewerOrigin('post-1', 1200)?.rect).toEqual(rect);
    expect(takeViewerOrigin('post-1', 1200)).toBeNull();
  });

  it('drops an origin recorded for a different item', () => {
    setViewerOrigin({ id: 'post-1', rect, previewUrl: 'u', radius: 12, recordedAt: 1000 });

    expect(takeViewerOrigin('post-2', 1100)).toBeNull();
    // A mismatch clears the hand-off so it cannot attach to a later open.
    expect(takeViewerOrigin('post-1', 1100)).toBeNull();
  });

  it('ignores an origin that went stale before the viewer mounted', () => {
    setViewerOrigin({ id: 'post-1', rect, previewUrl: 'u', radius: 12, recordedAt: 1000 });

    expect(takeViewerOrigin('post-1', 1000 + 2501)).toBeNull();
  });

  it('resolves null when the node cannot be measured', async () => {
    await expect(measureViewerOrigin(null)).resolves.toBeNull();
    await expect(measureViewerOrigin({ measureInWindow: (cb) => cb(0, 0, 0, 0) })).resolves.toBeNull();
    await expect(measureViewerOrigin({ measureInWindow: (cb) => cb(1, 2, 3, 4) })).resolves.toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });
});

describe('getContainedRect', () => {
  const frame = { width: 400, height: 800 };

  it('letterboxes wide media vertically centred', () => {
    expect(getContainedRect(frame, 2)).toEqual({ x: 0, y: 300, width: 400, height: 200 });
  });

  it('pillarboxes tall media horizontally centred', () => {
    expect(getContainedRect(frame, 0.25)).toEqual({ x: 100, y: 0, width: 200, height: 800 });
  });

  it('fills the frame when the ratio is unknown', () => {
    expect(getContainedRect(frame, null)).toEqual({ x: 0, y: 0, width: 400, height: 800 });
    expect(getContainedRect(frame, Number.NaN)).toEqual({ x: 0, y: 0, width: 400, height: 800 });
  });
});
