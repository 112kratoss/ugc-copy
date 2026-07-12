import { describe, expect, it } from 'vitest';

import {
  getPublicGenerationStartFailure,
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
});
