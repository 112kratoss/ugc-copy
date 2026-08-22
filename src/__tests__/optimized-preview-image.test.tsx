// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SUPABASE_URL = 'https://project.supabase.co';

describe('OptimizedPreviewImage', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it('serves a priority generated WebP directly while retaining Next preload behavior', async () => {
    const { OptimizedPreviewImage } = await import('@/app/components/OptimizedPreviewImage');
    const previewUrl = `${SUPABASE_URL}/storage/v1/object/sign/generated_images/user/image.preview.12345678.webp?token=test`;

    render(
      <OptimizedPreviewImage
        previewSrc={previewUrl}
        fallbackSrc={`${SUPABASE_URL}/storage/v1/object/sign/generated_images/user/image.png?token=test`}
        alt="Priority campaign still"
        sizes="100vw"
        priority
      />
    );

    const image = screen.getByRole('img', { name: 'Priority campaign still' });
    expect(image).toHaveAttribute('src', previewUrl);
    expect(image).toHaveAttribute('fetchpriority', 'high');
  });
});
