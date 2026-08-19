import { describe, expect, it, vi } from 'vitest';

import { runPagedQuery } from '@/lib/admin-paged-query';

function response(overrides: Record<string, unknown> = {}) {
  return { data: [], error: null, count: 0, status: 200, ...overrides };
}

describe('runPagedQuery', () => {
  it('returns the requested window with the full match count', async () => {
    const build = vi.fn().mockResolvedValue(
      response({ data: [{ id: 'a' }, { id: 'b' }], count: 61, status: 200 }),
    );

    const page = await runPagedQuery(build, { offset: 50, pageSize: 50 });

    expect(build).toHaveBeenCalledExactlyOnceWith(50, 99);
    expect(page).toEqual({ rows: [{ id: 'a' }, { id: 'b' }], total: 61, offset: 50 });
  });

  /**
   * The bug this helper exists for. PostgREST answers an out-of-range `.range()`
   * with 416, a null count and an unparseable body, so the previous
   * `if (error) throw` turned a stale bookmark into a 500 error page.
   */
  it('falls back to the first page when the offset is past the last row', async () => {
    const build = vi.fn()
      .mockResolvedValueOnce(response({
        data: null,
        count: null,
        status: 416,
        error: { message: '{"' },
      }))
      .mockResolvedValueOnce(response({ data: [{ id: 'a' }], count: 61, status: 200 }));

    const page = await runPagedQuery(build, { offset: 500, pageSize: 50 });

    expect(build).toHaveBeenNthCalledWith(1, 500, 549);
    expect(build).toHaveBeenNthCalledWith(2, 0, 49);
    // The corrected offset is reported so the pager renders the real window.
    expect(page).toEqual({ rows: [{ id: 'a' }], total: 61, offset: 0 });
  });

  it('still throws a genuine query error rather than silently showing page one', async () => {
    const build = vi.fn().mockResolvedValue(response({
      data: null,
      status: 400,
      error: new Error('column "nope" does not exist'),
    }));

    await expect(runPagedQuery(build, { offset: 0, pageSize: 25 }))
      .rejects.toThrow(/does not exist/);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('propagates a failure from the fallback instead of masking it as an empty page', async () => {
    const build = vi.fn()
      .mockResolvedValueOnce(response({ data: null, count: null, status: 416, error: {} }))
      .mockResolvedValueOnce(response({ data: null, status: 500, error: new Error('boom') }));

    await expect(runPagedQuery(build, { offset: 500, pageSize: 25 }))
      .rejects.toThrow(/boom/);
  });

  it('treats an empty table as an empty first page, not an out-of-range request', async () => {
    const build = vi.fn().mockResolvedValue(response({ data: [], count: 0, status: 200 }));

    const page = await runPagedQuery(build, { offset: 0, pageSize: 25 });

    expect(page).toEqual({ rows: [], total: 0, offset: 0 });
    expect(build).toHaveBeenCalledTimes(1);
  });
});
