import { expect, it } from 'vitest';
import { hasRepairableMediaPreviews } from '@/lib/media-preview-repair';

it('notices a long ready video whose missing teaser was never queued', async () => {
  const row: Record<string, unknown> = {
    id: 'long-video', media_kind: 'video', storage_path: 'posts/post/clip.mp4',
    preview_status: 'ready', preview_attempt_count: 1,
    rendition_status: 'ready', rendition_attempt_count: 1, rendition_storage_path: 'posts/post/clip.feed.mp4',
    duration_seconds: 37.97, teaser_storage_path: null, teaser_attempt_count: 0,
    teaser_locked_at: null,
  };
  const client = { from: (table: string) => {
    let eligible = table === 'post_media';
    const chain = {
      select: () => chain,
      eq: (key: string, value: unknown) => { eligible &&= row[key] === value; return chain; },
      in: (key: string, values: unknown[]) => { eligible &&= values.includes(row[key]); return chain; },
      is: (key: string, value: unknown) => { eligible &&= row[key] === value; return chain; },
      not: (key: string, _operator: string, value: unknown) => { eligible &&= row[key] !== value; return chain; },
      lt: (key: string, value: number) => { eligible &&= Number(row[key]) < value; return chain; },
      gt: (key: string, value: number) => { eligible &&= Number(row[key]) > value; return chain; },
      or: () => chain,
      like: () => chain,
      limit: async () => ({ data: eligible ? [row] : [], error: null }),
    };
    return chain;
  } };
  await expect(hasRepairableMediaPreviews(client as never)).resolves.toBe(true);
});
