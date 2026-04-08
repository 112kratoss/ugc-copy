import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HoverVideo } from '@/app/components/HoverVideo';

describe('HoverVideo', () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not autoplay by default', () => {
    const { container } = render(<HoverVideo src="https://example.com/video.mp4" />);
    const video = container.querySelector('video');

    expect(video).not.toBeNull();
    expect(video).not.toHaveAttribute('autoplay');
  });

  it('enables autoplay when requested', () => {
    const { container } = render(
      <HoverVideo
        src="https://example.com/video.mp4"
        autoPlay
      />
    );
    const video = container.querySelector('video');

    expect(video).not.toBeNull();
    expect(video).toHaveAttribute('autoplay');
  });
});
