import { describe, expect, it } from 'vitest';

import {
  GENERATION_PROMPT_BLOCKED_MESSAGE,
  getHeldProviderSubmissionGenerationId,
  getProviderInputRefusal,
  getPublicGenerationStartFailure,
  getRefundedStartGenerationId,
  markHeldProviderSubmission,
  markRefundedGenerationStart,
  normalizeGenerationStartFailureCode,
  PROVIDER_INPUT_REFUSED,
  PROVIDER_INPUT_REFUSED_MESSAGE,
  requiresReplacementGenerationInput,
} from '@/lib/generation-public-failure';

describe('public generation failure classification', () => {
  it.each([
    'invalid image_input',
    'Reference image is unreadable',
    'Image dimensions are below the minimum resolution',
    'Failed to decode the uploaded file',
    'No valid images were supplied',
  ])('classifies deterministic media failures as replacement-required: %s', (message) => {
    expect(getPublicGenerationStartFailure({ status: 422, message })).toMatchObject({
      code: 'invalid_input_media',
      message: expect.stringContaining('Start a new run'),
    });
  });

  it('does not mistake transient image-provider errors for bad uploads', () => {
    expect(getPublicGenerationStartFailure({ status: 429, message: 'Image generation capacity reached' }).code)
      .toBe('provider_busy');
    expect(getPublicGenerationStartFailure({ status: 503, message: 'Reference image service unavailable' }).code)
      .toBe('provider_unavailable');
    expect(getPublicGenerationStartFailure(new Error('Image generation timed out')).code)
      .toBe('provider_unavailable');
  });

  it('reads a provider refusal with no other signal as provider_rejected, and a 402 as insufficient credits', () => {
    // The start routes answer a refunded provider rejection from this code.
    expect(getPublicGenerationStartFailure(new Error('Your prompt was flagged by the safety filter.')).code)
      .toBe('provider_rejected');
    expect(getPublicGenerationStartFailure({ status: 402, message: 'Insufficient credits. This action costs 12 credits.' }))
      .toEqual({ code: 'insufficient_credits', message: 'Insufficient credits for this generation step.' });
  });

  it('explains a refused prompt instead of blaming the provider', () => {
    // Template and workflow runs map errors through here; a 422 would otherwise
    // read as "the provider could not accept this request".
    expect(getPublicGenerationStartFailure({
      status: 422,
      failureCode: 'prompt_blocked',
      message: 'anything',
    })).toEqual({ code: 'prompt_blocked', message: GENERATION_PROMPT_BLOCKED_MESSAGE });
    expect(GENERATION_PROMPT_BLOCKED_MESSAGE).toContain('No credits were used');
  });

  it('keeps an explicit server setup failure distinct from provider downtime', () => {
    expect(getPublicGenerationStartFailure({
      status: 503,
      failureCode: 'service_misconfigured',
      message: 'WEBHOOK_SECRET is not configured',
    })).toEqual({
      code: 'service_misconfigured',
      message: 'Generation setup is incomplete. No credits were charged for this attempt. Ask an administrator to finish the service setup before retrying.',
    });

    expect(requiresReplacementGenerationInput({
      code: 'service_misconfigured',
      message: 'Invalid image callback configuration.',
    })).toBe(false);
  });

  it('prefers a structured failure code and falls back to safe legacy copy', () => {
    expect(requiresReplacementGenerationInput({
      code: 'invalid_input_media',
      message: 'The request could not be completed.',
    })).toBe(true);
    expect(requiresReplacementGenerationInput({
      code: 'provider_unavailable',
      message: 'Invalid image dimensions.',
    })).toBe(false);
    expect(requiresReplacementGenerationInput({
      message: 'The generation model could not read one of the uploads.',
    })).toBe(true);
    expect(requiresReplacementGenerationInput({
      message: 'The generation provider timed out.',
    })).toBe(false);
  });

  // provider-input-limits: a start refuses, before any hold, what Kie would refuse after it.
  // Its words name the model and the limit, which a template's private recipe hides.
  describe('a request its provider would refuse', () => {
    const refusal = (message: string) => ({ status: 400, failureCode: PROVIDER_INPUT_REFUSED, message });

    it('ends the step under copy that names no model, limit or prompt', () => {
      const failure = getPublicGenerationStartFailure(
        refusal('Seedance 2.5 reference audio must be at least 2 seconds long. Beat runs 1.9 seconds.'),
      );

      expect(failure).toEqual({ code: 'provider_rejected', message: PROVIDER_INPUT_REFUSED_MESSAGE });
      expect(PROVIDER_INPUT_REFUSED_MESSAGE).toContain('No credits were used');
      expect(PROVIDER_INPUT_REFUSED_MESSAGE).not.toMatch(/seedance|second|character/i);
    });

    it.each([
      // A creator's label is part of the words: a run worker must not wait for a busy
      // provider, or ask for a new upload, because of what someone named a clip.
      'Kling 3.0 Cinematic video elements must be at least 3 seconds long. Busy street runs 2 seconds.',
      'Kling 3.0 Cinematic video elements must be at least 3 seconds long. Network outage intro runs 2.4 seconds.',
      'MiniMax H3 reference videos must be at least 2 seconds long. Invalid image runs 1 second.',
    ])('reads the code, never the words: %s', (message) => {
      expect(getPublicGenerationStartFailure(refusal(message)).code).toBe('provider_rejected');
    });

    it('is not a code a run fails with, so the start routes keep answering it as an invalid request', () => {
      expect(normalizeGenerationStartFailureCode(PROVIDER_INPUT_REFUSED)).toBeNull();
    });

    it('gives a caller that owns the recipe the refusal’s own words', () => {
      expect(getProviderInputRefusal(refusal('Z-Image prompts support up to 1,000 characters.')))
        .toBe('Z-Image prompts support up to 1,000 characters.');
      expect(getProviderInputRefusal(Object.assign(
        new Error('Z-Image prompts support up to 1,000 characters.'),
        { status: 400, failureCode: PROVIDER_INPUT_REFUSED },
      ))).toBe('Z-Image prompts support up to 1,000 characters.');
    });

    it.each([
      ['an error with no code', new Error('Z-Image prompts support up to 1,000 characters.')],
      ['another code', { status: 422, failureCode: 'prompt_blocked', message: 'anything' }],
      ['a refusal with no words', { status: 400, failureCode: PROVIDER_INPUT_REFUSED, message: '  ' }],
      ['no error at all', null],
    ])('gives nothing for %s', (_name, error) => {
      expect(getProviderInputRefusal(error)).toBeNull();
    });
  });

  describe('held provider submissions (F14)', () => {
    it('never tells the user to retry a submission whose credits are still held', () => {
      // A retry here starts a second generation and places a second hold while
      // the first submission may still be accepted and billed. This is the whole
      // reason the held case needs copy of its own rather than reusing the
      // provider_unavailable timeout copy.
      const error = new Error('KIE task creation request timed out after 30000ms.');
      error.name = 'ExternalServiceTimeoutError';
      markHeldProviderSubmission(error);

      const failure = getPublicGenerationStartFailure(error);
      expect(failure.code).toBe('submission_pending');
      expect(failure.message).not.toMatch(/retry/i);
      expect(failure.message).not.toMatch(/refund/i);
      expect(failure.message).toMatch(/credits stay reserved/i);
    });

    it('keeps the retry-friendly timeout copy when the generation was refunded', () => {
      // The same error type is refunded on the template path and held on every
      // other one. Keying the copy on the error shape instead of on the tag
      // would promise reserved credits to a user who has already been refunded.
      const error = new Error('KIE task creation request timed out after 30000ms.');
      error.name = 'ExternalServiceTimeoutError';

      const failure = getPublicGenerationStartFailure(error);
      expect(failure.code).toBe('provider_unavailable');
      expect(failure.message).toMatch(/retry/i);
    });

    it('does not leak the hold marker into a serialized error payload', () => {
      const error = new Error('timed out');
      markHeldProviderSubmission(error, 'generation-held-1');
      expect(Object.keys(error)).not.toContain('__magicbookletHeldSubmission');
      expect(Object.keys(error)).not.toContain('__magicbookletHeldGenerationId');
      expect(JSON.stringify({ ...error })).not.toMatch(/HeldSubmission/);
      expect(JSON.stringify({ ...error })).not.toContain('generation-held-1');
      expect(getHeldProviderSubmissionGenerationId(error)).toBe('generation-held-1');
    });

    it('preserves recovery metadata without promising a confirmed credit state', () => {
      const error = new Error('timed out');
      markHeldProviderSubmission(error, 'generation-unconfirmed', { confirmed: false });
      const failure = getPublicGenerationStartFailure(error);
      expect(failure.code).toBe('submission_pending');
      expect(failure.message).toContain('current status');
      expect(failure.message).not.toMatch(/credits stay reserved|retry/i);
      expect(getHeldProviderSubmissionGenerationId(error)).toBe('generation-unconfirmed');
      expect(JSON.stringify(error)).toBe('{}');
    });

    it('only exposes recovery metadata for errors that carry the held marker', () => {
      const error = new Error('timed out');
      Object.defineProperty(error, '__magicbookletHeldGenerationId', {
        value: 'generation-forged',
      });

      expect(getHeldProviderSubmissionGenerationId(error)).toBeNull();
      markHeldProviderSubmission(error);
      expect(getHeldProviderSubmissionGenerationId(error)).toBe('generation-forged');
    });

    it('ignores non-object errors rather than throwing', () => {
      // A primitive cannot carry the tag, so it must never be classified as
      // held -- that copy promises reserved credits.
      expect(() => markHeldProviderSubmission('timed out')).not.toThrow();
      expect(() => markHeldProviderSubmission(null)).not.toThrow();
      expect(getPublicGenerationStartFailure('timed out').code).not.toBe('submission_pending');
      expect(getPublicGenerationStartFailure(null).code).not.toBe('submission_pending');
    });
  });

  describe('starts that were failed and refunded', () => {
    it('carries the refunded generation to whoever catches the error', () => {
      const error = new Error('Provider rejected the request');
      expect(getRefundedStartGenerationId(error)).toBeNull();

      markRefundedGenerationStart(error, 'generation-refunded-1');
      expect(getRefundedStartGenerationId(error)).toBe('generation-refunded-1');
    });

    it('changes nothing the person is told about the failure', () => {
      // The mark says what happened to the hold. The copy still comes from
      // what the provider answered, and a refunded start is never a held one.
      const error = Object.assign(new Error('Too many requests'), { status: 429 });
      const before = getPublicGenerationStartFailure(error);

      markRefundedGenerationStart(error, 'generation-refunded-1');

      expect(getPublicGenerationStartFailure(error)).toEqual(before);
      expect(getHeldProviderSubmissionGenerationId(error)).toBeNull();
    });

    it('does not leak the mark into a serialized error payload', () => {
      const error = new Error('Provider rejected the request');
      markRefundedGenerationStart(error, 'generation-refunded-1');

      expect(Object.keys(error)).toEqual([]);
      expect(JSON.stringify({ ...error })).toBe('{}');
      expect(JSON.stringify(error)).toBe('{}');
    });

    it('ignores non-object errors rather than throwing', () => {
      expect(() => markRefundedGenerationStart('rejected', 'generation-refunded-1')).not.toThrow();
      expect(() => markRefundedGenerationStart(null, 'generation-refunded-1')).not.toThrow();
      expect(getRefundedStartGenerationId('rejected')).toBeNull();
      expect(getRefundedStartGenerationId(null)).toBeNull();
    });
  });
});
