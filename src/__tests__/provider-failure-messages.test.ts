import { describe, expect, it } from 'vitest';

import {
  describeProviderFailure,
  UNKNOWN_PROVIDER_FAILURE,
} from '@/lib/provider-failure-messages';

describe('describeProviderFailure', () => {
  // Both strings are verbatim Kie responses observed on 2026-09-02: five
  // Seedance generations were rejected at input moderation, and the two models
  // reported the identical cause in formats sharing no common substring.
  const SEEDANCE_2_REJECTION =
    "The request failed because the input image 'content[0]' may contain real person.";
  const SEEDANCE_2_5_REJECTION = 'InputImageSensitiveContentDetected.PolicyViolation';

  it('rewrites the prose likeness rejection into something a creator can act on', () => {
    const described = describeProviderFailure(SEEDANCE_2_REJECTION);

    expect(described).not.toBe(SEEDANCE_2_REJECTION);
    expect(described).toContain('reference image');
    expect(described).toContain('real person');
    // The provider's own framing leaks implementation detail the creator has no
    // way to act on.
    expect(described).not.toContain('content[0]');
  });

  it('rewrites the dotted machine code to the same guidance', () => {
    // The two models disagree on format but not on cause, so a creator hitting
    // either must be told the same thing.
    expect(describeProviderFailure(SEEDANCE_2_5_REJECTION)).toBe(
      describeProviderFailure(SEEDANCE_2_REJECTION),
    );
    expect(describeProviderFailure(SEEDANCE_2_5_REJECTION)).not.toContain('PolicyViolation');
  });

  it('matches the rejection regardless of case or surrounding text', () => {
    expect(describeProviderFailure('inputimagesensitivecontentdetected.policyviolation')).toBe(
      describeProviderFailure(SEEDANCE_2_5_REJECTION),
    );
    expect(
      describeProviderFailure('Task failed: the input image may contain a real person, aborting.'),
    ).toBe(describeProviderFailure(SEEDANCE_2_REJECTION));
  });

  it('passes an unrecognised provider message through untouched', () => {
    // A new provider message must reach the operator verbatim rather than be
    // flattened into a wrong explanation.
    expect(describeProviderFailure('Upstream model capacity exceeded.')).toBe(
      'Upstream model capacity exceeded.',
    );
  });

  it('falls back rather than persisting an empty reason', () => {
    expect(describeProviderFailure(null)).toBe(UNKNOWN_PROVIDER_FAILURE);
    expect(describeProviderFailure(undefined)).toBe(UNKNOWN_PROVIDER_FAILURE);
    expect(describeProviderFailure('   ')).toBe(UNKNOWN_PROVIDER_FAILURE);
  });

  it('trims surrounding whitespace off a passed-through message', () => {
    expect(describeProviderFailure('  Upstream timeout.  ')).toBe('Upstream timeout.');
  });
});
