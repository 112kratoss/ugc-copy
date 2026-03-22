import { describe, expect, it } from 'vitest';
import { buildMediaProxyUrl, getDisplayMediaUrl, getStoredMediaLocation } from '@/lib/media-urls';

describe('media url helpers', () => {
  it('parses stored media paths', () => {
    expect(getStoredMediaLocation('generated_images/user/file.jpg')).toEqual({
      bucket: 'generated_images',
      filePath: 'user/file.jpg',
    });
  });

  it('parses signed supabase storage urls', () => {
    expect(getStoredMediaLocation('https://project.supabase.co/storage/v1/object/sign/generated_videos/user%2Fclip.mp4?token=abc')).toEqual({
      bucket: 'generated_videos',
      filePath: 'user/clip.mp4',
    });
  });

  it('converts stored media into same-origin proxy urls for display', () => {
    expect(getDisplayMediaUrl('generated_audio/user/track.mp3')).toBe(
      buildMediaProxyUrl('generated_audio', 'user/track.mp3')
    );
  });

  it('keeps external urls unchanged', () => {
    expect(getDisplayMediaUrl('https://cdn.example.com/file.jpg')).toBe('https://cdn.example.com/file.jpg');
  });
});
