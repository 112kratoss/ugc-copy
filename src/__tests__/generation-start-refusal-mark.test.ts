import { describe, expect, it } from 'vitest';

import {
  getGenerationStartRefusal,
  getHeldProviderSubmissionGenerationId,
  getInProgressStartGenerationId,
  getPublicGenerationStartFailure,
  getRefundedStartGenerationId,
  markGenerationStartInProgress,
  markGenerationStartRefusal,
  markHeldProviderSubmission,
  markRefundedGenerationStart,
  type GenerationStartRefusal,
} from '@/lib/generation-public-failure';

// The start functions refuse some starts for what their row is, and all of
// those reach a caller as the same 409. The start service names the answer on
// the error so a run worker can tell them apart. Nothing a request answers
// with changes.
describe('a start the database refused outright', () => {
  const refused = () => Object.assign(new Error('This template step has already started.'), { status: 409 });
  const REFUSALS: GenerationStartRefusal[] = [
    'invalid_template_context',
    'template_step_already_started',
    'key_already_used',
  ];

  it.each(REFUSALS)('carries the answer %s to whoever catches the error', (refusal) => {
    const error = refused();
    expect(getGenerationStartRefusal(error)).toBeNull();

    markGenerationStartRefusal(error, refusal);

    expect(getGenerationStartRefusal(error)).toBe(refusal);
  });

  it('names no refusal from an answer it does not know', () => {
    const error = refused();

    markGenerationStartRefusal(error, 'in_progress' as GenerationStartRefusal);

    expect(getGenerationStartRefusal(error)).toBeNull();
  });

  it('changes nothing a request answers with', () => {
    const error = refused();
    const before = getPublicGenerationStartFailure(error);

    markGenerationStartRefusal(error, 'template_step_already_started');

    expect(getPublicGenerationStartFailure(error)).toEqual(before);
    expect(error.status).toBe(409);
  });

  it('does not leak into a serialized error payload', () => {
    const error = refused();

    markGenerationStartRefusal(error, 'key_already_used');

    expect(Object.keys(error)).toEqual(['status']);
    expect(JSON.stringify({ ...error })).toBe('{"status":409}');
    expect(JSON.stringify(error)).toBe('{"status":409}');
  });

  it('is a mark of its own: not in progress, not held, and not refunded', () => {
    const error = refused();
    markGenerationStartRefusal(error, 'invalid_template_context');
    expect(getInProgressStartGenerationId(error)).toBeNull();
    expect(getHeldProviderSubmissionGenerationId(error)).toBeNull();
    expect(getRefundedStartGenerationId(error)).toBeNull();

    // The 409 of a start that is still in progress is the one a run worker
    // takes back. It is no refusal, and neither is a held or a refunded start.
    const inProgress = refused();
    markGenerationStartInProgress(inProgress, 'generation-first');
    expect(getGenerationStartRefusal(inProgress)).toBeNull();

    const held = new Error('timed out');
    markHeldProviderSubmission(held, 'generation-held');
    expect(getGenerationStartRefusal(held)).toBeNull();

    const refunded = new Error('Provider rejected the request');
    markRefundedGenerationStart(refunded, 'generation-refunded');
    expect(getGenerationStartRefusal(refunded)).toBeNull();
  });

  it('ignores non-object errors rather than throwing', () => {
    expect(() => markGenerationStartRefusal('refused', 'key_already_used')).not.toThrow();
    expect(() => markGenerationStartRefusal(null, 'key_already_used')).not.toThrow();
    expect(getGenerationStartRefusal('refused')).toBeNull();
    expect(getGenerationStartRefusal(null)).toBeNull();
    expect(getGenerationStartRefusal(undefined)).toBeNull();
  });
});
