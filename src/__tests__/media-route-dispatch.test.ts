import { NextRequest } from 'next/server';
import { expect, it, vi } from 'vitest';
const handlers = vi.hoisted(() => ({ post: vi.fn(async () => new Response(null, { status: 302 })), owner: vi.fn(async () => new Response(null, { status: 200 })) }));
vi.mock('@/lib/post-media-route-adapter-service', () => ({ getPostMediaRouteResponse: handlers.post }));
vi.mock('@/lib/media-route-adapter-service', () => ({ getMediaRouteResponse: handlers.owner }));
import { GET } from '@/app/api/media/route';
it('keeps uploaded post reads on the media URL already authenticated by installed clients', async () => {
  const request = new NextRequest('https://app.test/api/media?bucket=post_media&path=private-posts/post/a');
  expect((await GET(request)).status).toBe(302);
  expect(handlers.post).toHaveBeenCalledWith(request);
  expect(handlers.owner).not.toHaveBeenCalled();
});
