import { describe, expect, it } from 'vitest';

import { generationToProfileMediaCard } from '../lib/profile-view-model';
import type { GenerationListItem } from '../lib/types';

describe('profile view model media cards', () => {
  it('maps generation previewUrl so video creation tiles can render persisted posters', () => {
    const item: GenerationListItem = {
      id: 'gen-video-1',
      output_url: 'https://cdn.example.com/video.mp4',
      preview_url: 'https://cdn.example.com/video-poster.webp',
      status: 'succeeded',
      created_at: '2026-06-10T10:00:00.000Z',
      completed_at: '2026-06-10T10:01:00.000Z',
      model: 'kling-3.0-video',
      category: 'video',
      title: 'Street motion',
      prompt: 'A creator walks through a market.',
    };

    expect(generationToProfileMediaCard(item).previewUrl).toBe('https://cdn.example.com/video-poster.webp');
  });

  it('uses image output as the preview for image generations when no explicit poster exists', () => {
    const item: GenerationListItem = {
      id: 'gen-image-1',
      output_url: 'https://cdn.example.com/image.jpg',
      status: 'succeeded',
      created_at: '2026-06-10T10:00:00.000Z',
      completed_at: '2026-06-10T10:01:00.000Z',
      model: 'nano-banana-2',
      category: 'image',
      title: 'Image still',
      prompt: 'A product still.',
    };

    expect(generationToProfileMediaCard(item).previewUrl).toBe('https://cdn.example.com/image.jpg');
  });

  it('does not use the video file as a preview when a poster is missing', () => {
    const item: GenerationListItem = {
      id: 'gen-video-missing-poster',
      output_url: 'https://cdn.example.com/video.mp4',
      status: 'succeeded',
      created_at: '2026-06-10T10:00:00.000Z',
      completed_at: '2026-06-10T10:01:00.000Z',
      model: 'kling-3.0-video',
      category: 'video',
      title: 'Video only',
      prompt: 'A video generation.',
    };

    expect(generationToProfileMediaCard(item).previewUrl).toBeNull();
  });
});
