import { afterEach, describe, expect, it, vi } from 'vitest';

const repairState = vi.hoisted(() => ({
  repair: vi.fn(async () => ({ attempted: 2, completed: 2, failed: 0 })),
}));

vi.mock('@/lib/media-preview-repair', () => ({
  repairMediaPreviews: repairState.repair,
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({ service: true }),
}));

describe('media preview repair cron', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    repairState.repair.mockClear();
  });

  it('requires the cron secret', async () => {
    vi.stubEnv('CRON_SECRET', 'secret');
    const { GET } = await import('@/app/api/cron/media-preview-repair/route');
    const response = await GET(new Request('http://localhost/api/cron/media-preview-repair'));
    expect(response.status).toBe(401);
    expect(repairState.repair).not.toHaveBeenCalled();
  });

  it('runs the shared repair service for authorized calls', async () => {
    vi.stubEnv('CRON_SECRET', 'secret');
    const { GET } = await import('@/app/api/cron/media-preview-repair/route');
    const response = await GET(new Request('http://localhost/api/cron/media-preview-repair', {
      headers: { authorization: 'Bearer secret' },
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      summary: { attempted: 2, completed: 2, failed: 0 },
    });
  });
});
