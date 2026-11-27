import { describe, expect, it } from 'vitest';

import { isUnconfirmedOutcome, readJsonResponse } from '@/lib/read-json-response';

describe('isUnconfirmedOutcome', () => {
  it('is unknown after a 5xx with no explanation of the server\'s own (an HTML 502/504)', () => {
    expect(isUnconfirmedOutcome(new Response(null, { status: 502 }), {})).toBe(true);
    expect(isUnconfirmedOutcome(new Response(null, { status: 504 }), {})).toBe(true);
  });

  it('is unknown after a success status whose body could not be read', () => {
    expect(isUnconfirmedOutcome(new Response(null, { status: 200 }), {})).toBe(true);
  });

  it('is known for a refusal (4xx), with or without a body', () => {
    expect(isUnconfirmedOutcome(new Response(null, { status: 402 }), {})).toBe(false);
    expect(isUnconfirmedOutcome(new Response(null, { status: 409 }), { error: 'Price changed' })).toBe(false);
  });

  it('is known when the server explained its own failure', () => {
    expect(isUnconfirmedOutcome(new Response(null, { status: 500 }), { error: 'Unlock failed' })).toBe(false);
  });
});

// The platform answers a timed-out or crashed function with an HTML 502/504. A client that read
// `await response.json()` before checking `response.ok` threw "Unexpected token '<'…" and showed
// those words to the person, an unlock paid with credits included. The helper never throws: a body
// that is not JSON reads as an empty object, so each caller shows its own fallback message.
describe('readJsonResponse', () => {
  it('returns the parsed body of a JSON answer', async () => {
    const response = new Response(JSON.stringify({ ok: true, count: 3 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    await expect(readJsonResponse(response)).resolves.toEqual({ ok: true, count: 3 });
  });

  it('returns the parsed error body of a failed JSON answer', async () => {
    const response = new Response(JSON.stringify({ error: 'Not enough credits' }), { status: 402 });
    await expect(readJsonResponse(response)).resolves.toEqual({ error: 'Not enough credits' });
  });

  it('returns an empty object for an HTML 502, where response.json() throws', async () => {
    const html = '<!DOCTYPE html><html><body>502 Bad Gateway</body></html>';
    await expect(new Response(html, { status: 502 }).json()).rejects.toThrow();
    await expect(readJsonResponse(new Response(html, { status: 502 }))).resolves.toEqual({});
  });

  it('returns an empty object for an empty body', async () => {
    await expect(readJsonResponse(new Response(null, { status: 504 }))).resolves.toEqual({});
  });

  it('returns an empty object for JSON that is not an object (null, a string)', async () => {
    await expect(readJsonResponse(new Response('null', { status: 500 }))).resolves.toEqual({});
    await expect(readJsonResponse(new Response('"oops"', { status: 500 }))).resolves.toEqual({});
  });

  it('keeps a JSON array, which some lists answer with', async () => {
    await expect(readJsonResponse(new Response('[1,2]', { status: 200 }))).resolves.toEqual([1, 2]);
  });

  it('returns an empty object when the body was already read', async () => {
    const response = new Response('{"a":1}', { status: 200 });
    await response.text();
    await expect(readJsonResponse(response)).resolves.toEqual({});
  });
});
