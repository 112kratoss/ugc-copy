import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Next 16 deprecated next/image's `priority` for `preload`, and the creator page's full-width
// cover, likely its largest paint, loaded lazily at default priority (audit 2026-11-27).

const imageProps = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => {
    imageProps.push(props);
    // eslint-disable-next-line @next/next/no-img-element
    return <img alt={String(props.alt)} />;
  },
}));

afterEach(() => {
  cleanup();
  imageProps.length = 0;
});

describe('OptimizedPreviewImage', () => {
  it('passes `preload`, never the deprecated `priority`, for a priority picture', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    const { OptimizedPreviewImage } = await import('@/components/OptimizedPreviewImage');
    render(
      <OptimizedPreviewImage
        previewSrc="https://example.supabase.co/storage/v1/object/public/showcase_media/a/image.preview.12345678.webp"
        alt="Priority still"
        sizes="100vw"
        priority
      />,
    );
    expect(imageProps).toHaveLength(1);
    expect(imageProps[0]).not.toHaveProperty('priority');
    expect(imageProps[0].preload).toBe(true);
    expect(imageProps[0].fetchPriority).toBe('high');
    vi.unstubAllEnvs();
  });
});

describe('the creator page cover', () => {
  it('loads eagerly at high priority', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/app/creators/[username]/CreatorProfileHeader.tsx'), 'utf8');
    const cover = source.slice(source.indexOf('src={profile.coverUrl}'), source.indexOf('/>', source.indexOf('src={profile.coverUrl}')));
    expect(cover).toContain('loading="eager"');
    expect(cover).toContain('fetchPriority="high"');
  });
});
