import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { decodeTemplateCursor } from '@/lib/media-template-service';

/**
 * Security audit, 2026-11-26. `GET /api/templates` takes no sign-in and reads
 * with the service role. Its cursor's two values go into a PostgREST `.or()`
 * expression, which postgrest-js does not escape, so a cursor whose
 * `createdAt` was `2000-01-01,name.like.*x*` added a filter of the caller's
 * own to the query. A cursor is now two values of the shapes the server
 * writes, or it is no cursor.
 */
const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
const ID = '0b6f0c8e-6f0a-4b1e-9a51-3c1f2f6d7e10';

describe('the public templates cursor', () => {
  it('reads the cursor the server writes', () => {
    for (const createdAt of [
      '2026-11-26T10:12:46.123456+00:00',
      '2026-11-26T10:12:46+00:00',
      '2026-11-26T10:12:46.5Z',
    ]) {
      expect(decodeTemplateCursor(encode({ createdAt, id: ID }))).toEqual({ createdAt, id: ID });
    }
  });

  it('is no cursor when either value could carry a filter', () => {
    for (const cursor of [
      { createdAt: '2000-01-01,name.like.*x*', id: ID },
      { createdAt: '2026-11-26T10:12:46+00:00),or(status.eq.draft', id: ID },
      { createdAt: '2026-11-26T10:12:46+00:00', id: `${ID},creator_user_id.not.is.null` },
      { createdAt: '2026-11-26T10:12:46+00:00', id: `${ID})` },
      { createdAt: '2026-11-26', id: ID },
      { createdAt: '2026-11-26T10:12:46+00:00', id: 'not-a-uuid' },
      { createdAt: 1, id: ID },
      { id: ID },
    ]) {
      expect(decodeTemplateCursor(encode(cursor))).toBeNull();
    }
  });

  it('is no cursor when it is not the server\'s encoding or is oversized', () => {
    expect(decodeTemplateCursor('%%%')).toBeNull();
    expect(decodeTemplateCursor(encode('text'))).toBeNull();
    expect(decodeTemplateCursor(encode({ createdAt: '2026-11-26T10:12:46+00:00', id: ID, pad: 'x'.repeat(4000) }))).toBeNull();
    expect(decodeTemplateCursor(null)).toBeNull();
  });
});
