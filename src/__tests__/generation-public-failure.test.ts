import { describe, expect, it } from 'vitest';

import {
  getHeldProviderSubmissionGenerationId,
  getPublicGenerationStartFailure,
  markHeldProviderSubmission,
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
});
