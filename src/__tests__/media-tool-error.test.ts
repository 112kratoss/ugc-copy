import { describe, expect, it } from 'vitest';

import { summarizeMediaToolError, truncateMediaToolMessage } from '@/lib/media-tool-error';

/** The shape ffmpeg actually produces: a long identical banner, then the reason. */
function ffmpegFailure(reason: string) {
  const banner = [
    'ffmpeg version 7.0.2-static https://johnvansickle.com/ffmpeg/  Copyright (c) 2000-2024 the FFmpeg developers',
    '  built with gcc 8 (Debian 8.3.0-6)',
    `  configuration: ${Array.from({ length: 40 }, (_, i) => `--enable-lib${i}`).join(' ')}`,
  ].join('\n');
  return new Error(`ffmpeg exited with code 254: ${banner}\n${reason}`);
}

describe('media tool error messages', () => {
  it('keeps the reason ffmpeg failed, not just its build banner', () => {
    const reason = "input-video: No such file or directory";
    const stored = summarizeMediaToolError(ffmpegFailure(reason), 'Preview generation failed.');

    expect(stored.length).toBeLessThanOrEqual(500);
    expect(stored).toContain(reason);
    // The head still names the failure, so the column reads as one message.
    expect(stored).toContain('ffmpeg exited with code 254');
  });

  it('leaves a message that already fits completely alone', () => {
    expect(truncateMediaToolMessage('Media type does not support a visual preview.'))
      .toBe('Media type does not support a visual preview.');
  });

  it('falls back when there is no message to store', () => {
    expect(summarizeMediaToolError(null, 'Preview generation failed.')).toBe('Preview generation failed.');
    expect(summarizeMediaToolError(new Error('   '), 'Preview generation failed.')).toBe('Preview generation failed.');
  });

  it('keeps the tail when the budget cannot hold both ends', () => {
    const stored = truncateMediaToolMessage(`${'x'.repeat(400)}THE-REASON`, 40);
    expect(stored).toHaveLength(40);
    expect(stored.endsWith('THE-REASON')).toBe(true);
  });
});
