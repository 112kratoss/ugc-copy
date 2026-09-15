import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatSupportDetails,
  readCreatorSession,
  recordCreatorSession,
  resetCreatorSessionForTests,
  subscribeCreatorSession,
  type CreatorSessionDiagnostics,
} from '../lib/creator-session-diagnostics';

const RECOVERED_VIDEO: CreatorSessionDiagnostics = {
  tool: 'video',
  outcome: 'recovered',
  referenceCount: 2,
  catalogRevision: 'rev-2026-09-15',
  draftFormat: 'v1 per identity, remix 4',
};

beforeEach(() => {
  resetCreatorSessionForTests();
});

// Audit, "OTA and the reported iPhone issue": support diagnostics for the
// runtime, channel, catalog revision, draft format, reference count and
// restore outcome, with no prompts or links.
describe('support details', () => {
  it('reads how the last draft came back, after the OTA runtime and channel', () => {
    expect(formatSupportDetails({ runtimeVersion: '0.1.4', channel: 'production', session: RECOVERED_VIDEO })).toBe(
      'Runtime 0.1.4 · channel production · video draft repaired from its source, 2 references · catalog rev-2026-09-15 · drafts v1 per identity, remix 4',
    );
  });

  it('counts one reference in the singular and leaves out what it does not know', () => {
    expect(formatSupportDetails({
      runtimeVersion: null,
      channel: null,
      session: { ...RECOVERED_VIDEO, tool: 'image', outcome: 'resumed', referenceCount: 1, catalogRevision: null },
    })).toBe('Image draft resumed, 1 reference · drafts v1 per identity, remix 4');
  });

  it('shows nothing in a dev client before any draft has opened', () => {
    expect(formatSupportDetails({ runtimeVersion: null, channel: null, session: null })).toBeNull();
  });

  it('keeps the last session for this launch and tells whoever is showing it', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCreatorSession(listener);

    recordCreatorSession(RECOVERED_VIDEO);

    expect(readCreatorSession()).toEqual(RECOVERED_VIDEO);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    recordCreatorSession({ ...RECOVERED_VIDEO, outcome: 'restore_failed' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(readCreatorSession()?.outcome).toBe('restore_failed');
  });
});
