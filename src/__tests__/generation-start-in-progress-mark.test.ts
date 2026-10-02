import { describe, expect, it } from 'vitest';

import {
  GENERATION_SUBMISSION_PENDING_MESSAGE,
  getHeldProviderSubmissionGenerationId,
  getInProgressStartGenerationId,
  getPublicGenerationStartFailure,
  getRefundedStartGenerationId,
  markGenerationStartInProgress,
  markHeldProviderSubmission,
  markRefundedGenerationStart,
} from '@/lib/generation-public-failure';

// A start repeated with the same request key can find the first one still
// unresolved. The start service names that generation on the error so a run
// worker, which made both starts, can take it back. Nothing a person is told
// changes.
describe('a start that is still in progress', () => {
  const alreadyStarting = () => Object.assign(
    new Error('A generation with this idempotency key is already starting. Retry shortly.'),
    { status: 409 },
  );

  it('carries the generation holding the key to whoever catches the error', () => {
    const error = alreadyStarting();
    expect(getInProgressStartGenerationId(error)).toBeNull();

    markGenerationStartInProgress(error, 'generation-first');

    expect(getInProgressStartGenerationId(error)).toBe('generation-first');
  });

  it('names no generation from a blank id', () => {
    const error = alreadyStarting();

    markGenerationStartInProgress(error, '   ');

    expect(getInProgressStartGenerationId(error)).toBeNull();
  });

  it('changes nothing a request answers with', () => {
    // A route answers a held submission with its own code and copy, and the
    // client stops retrying. This error has to stay the plain 409 it was, so
    // that the client retries and receives the replay.
    const error = alreadyStarting();
    const before = getPublicGenerationStartFailure(error);

    markGenerationStartInProgress(error, 'generation-first');

    expect(getPublicGenerationStartFailure(error)).toEqual(before);
    expect(getPublicGenerationStartFailure(error).code).not.toBe('submission_pending');
  });

  it('does not leak into a serialized error payload', () => {
    const error = alreadyStarting();

    markGenerationStartInProgress(error, 'generation-first');

    expect(Object.keys(error)).toEqual(['status']);
    expect(JSON.stringify({ ...error })).toBe('{"status":409}');
    expect(JSON.stringify(error)).toBe('{"status":409}');
  });

  it('is a mark of its own: not held, and not refunded', () => {
    const error = alreadyStarting();
    markGenerationStartInProgress(error, 'generation-first');
    expect(getHeldProviderSubmissionGenerationId(error)).toBeNull();
    expect(getRefundedStartGenerationId(error)).toBeNull();

    // A held or a refunded start names its generation too, and neither is
    // one to take back: the first is linked as held, the second is over.
    const held = new Error('timed out');
    markHeldProviderSubmission(held, 'generation-held');
    expect(getInProgressStartGenerationId(held)).toBeNull();

    const refunded = new Error('Provider rejected the request');
    markRefundedGenerationStart(refunded, 'generation-refunded');
    expect(getInProgressStartGenerationId(refunded)).toBeNull();
  });

  it('ignores non-object errors rather than throwing', () => {
    expect(() => markGenerationStartInProgress('already starting', 'generation-first')).not.toThrow();
    expect(() => markGenerationStartInProgress(null, 'generation-first')).not.toThrow();
    expect(getInProgressStartGenerationId('already starting')).toBeNull();
    expect(getInProgressStartGenerationId(null)).toBeNull();
    expect(getInProgressStartGenerationId(undefined)).toBeNull();
  });

  it('shares its words with a held submission, which is the state that generation is in', () => {
    const held = new Error('timed out');
    markHeldProviderSubmission(held, 'generation-held');

    expect(getPublicGenerationStartFailure(held)).toEqual({
      code: 'submission_pending',
      message: GENERATION_SUBMISSION_PENDING_MESSAGE,
    });
    // Never an invitation to start it again while the first may still be billed.
    expect(GENERATION_SUBMISSION_PENDING_MESSAGE).not.toMatch(/retry/i);
    expect(GENERATION_SUBMISSION_PENDING_MESSAGE).toMatch(/credits stay reserved/i);
  });
});
