import { describe, expect, it } from 'vitest';

import {
  describeProviderFailure,
  readProviderFailureReason,
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

  it('falls back to a generic display message for a blank reason', () => {
    expect(describeProviderFailure(null)).toBe(UNKNOWN_PROVIDER_FAILURE);
    expect(describeProviderFailure(undefined)).toBe(UNKNOWN_PROVIDER_FAILURE);
    expect(describeProviderFailure('   ')).toBe(UNKNOWN_PROVIDER_FAILURE);
  });

  it('trims surrounding whitespace off a passed-through message', () => {
    expect(describeProviderFailure('  Upstream timeout.  ')).toBe('Upstream timeout.');
  });
});

describe('readProviderFailureReason', () => {
  // The reason to *store*: the provider's own words, rewritten for creators, or
  // null when the task carries none. A placeholder is not a reason, and because
  // `settle_generation_failed` keeps a stored reason only against a blank one, a
  // stored placeholder would also be able to erase a real reason.
  const SEEDANCE_2_5_REJECTION = 'InputImageSensitiveContentDetected.PolicyViolation';

  it('reads the market failMsg and the Veo errorMessage', () => {
    expect(readProviderFailureReason({ failMsg: 'Upstream timeout.' })).toBe('Upstream timeout.');
    expect(readProviderFailureReason({ errorMessage: 'Upstream timeout.' })).toBe('Upstream timeout.');
  });

  it('prefers failMsg when a task carries both fields', () => {
    expect(readProviderFailureReason({ failMsg: 'Market reason.', errorMessage: 'Veo reason.' })).toBe(
      'Market reason.',
    );
  });

  it('rewrites a recognised rejection exactly as describeProviderFailure does', () => {
    expect(readProviderFailureReason({ failMsg: SEEDANCE_2_5_REJECTION })).toBe(
      describeProviderFailure(SEEDANCE_2_5_REJECTION),
    );
  });

  it('returns null rather than a placeholder when the task carries no reason', () => {
    for (const task of [null, undefined, 'failed', {}, { failMsg: '   ' }, { failMsg: null, errorMessage: '' }]) {
      expect(readProviderFailureReason(task)).toBeNull();
    }
  });

  it('never reads the response envelope', () => {
    // A code-200 Kie body carries `msg: "success"` at the top level. Only the
    // task object's own fields explain a failure.
    expect(readProviderFailureReason({ code: 200, msg: 'success' })).toBeNull();
  });
});
