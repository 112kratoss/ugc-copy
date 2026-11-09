import { describe, expect, it } from 'vitest';

import {
  creatorNameStepReducer,
  creatorNameStepShownCookie,
  describeHandleLine,
  HANDLE_AVAILABLE_TEXT,
  HANDLE_CHECKING_TEXT,
  HANDLE_JUST_CLAIMED_TEXT,
  HANDLE_UNAVAILABLE_TEXT,
  initialCreatorNameStepState,
  isWellFormedHandle,
  localHandleRefusal,
  readCreatorNameStepShownFor,
  shouldReopenCreatorNameStep,
  startCreatorNameStep,
  type CreatorNameStepAction,
  type CreatorNameStepState,
} from '@/lib/creator-name-step';
import { PUBLIC_HANDLE_RULE } from '@/lib/public-identity';
import { withReferralClaimStatus } from '@/lib/referral';

const PLACEHOLDER = { username: 'creator-a1b2c3d4', displayName: null };
const KIRAN = { email: 'kiran@example.com', user_metadata: { full_name: 'Kiran Das' } };
const taken = { state: 'taken' as const, message: 'That username is already taken.' };

function run(state: CreatorNameStepState, ...actions: CreatorNameStepAction[]) {
  return actions.reduce(creatorNameStepReducer, state);
}

function stepFor(displayName: string, email: string | null = null) {
  return initialCreatorNameStepState(startCreatorNameStep(PLACEHOLDER, { email, user_metadata: { full_name: displayName } }));
}

describe('where the creator-name step starts (owner, 2026-11-08)', () => {
  it('suggests a handle from the sign-in name, else the email, else creator and three digits', () => {
    expect(startCreatorNameStep(PLACEHOLDER, KIRAN)).toEqual({
      displayName: 'Kiran Das',
      username: 'kiran-das',
      suggestion: { current: 'kiran-das', swaps: 0, taken: [] },
    });
    expect(startCreatorNameStep(PLACEHOLDER, { email: 'maya.k@example.com', user_metadata: {} })).toMatchObject({
      displayName: 'maya.k',
      username: 'maya-k',
    });
    expect(startCreatorNameStep(PLACEHOLDER, { email: null, user_metadata: { name: 'ആതിര' } }, () => 0.5)).toMatchObject({
      displayName: 'ആതിര',
      username: 'creator550',
    });
  });

  it('opens on "Creator" when the sign-in gives no name at all, as the app does', () => {
    expect(startCreatorNameStep(null, { email: null, user_metadata: {} }, () => 0)).toMatchObject({
      displayName: 'Creator',
      username: 'creator',
    });
  });

  it('never suggests a reserved handle', () => {
    expect(startCreatorNameStep(PLACEHOLDER, { email: 'maya@example.com', user_metadata: { full_name: 'Support' } })).toMatchObject({
      displayName: 'Support',
      username: 'maya',
    });
  });

  it('keeps a handle the account already claimed, and the profile’s own name', () => {
    expect(startCreatorNameStep({ username: 'kiran-studio', displayName: null }, KIRAN)).toEqual({
      displayName: 'Kiran Das',
      username: 'kiran-studio',
      suggestion: null,
    });
    expect(startCreatorNameStep({ username: 'creator-a1b2c3d4', displayName: 'Kiran D.' }, KIRAN).displayName).toBe('Kiran D.');
  });
});

describe('the suggested handle while the step is open', () => {
  it('follows the display name while the field still holds the suggestion', () => {
    const state = run(stepFor('Kiran Das'), { type: 'name-typed', value: 'Kiran Das Kumar', roll: 0 });
    expect(state.username).toBe('kiran-das-kumar');
    expect(state.displayName).toBe('Kiran Das Kumar');
  });

  it('keeps the last handle for a name that makes none', () => {
    const state = run(stepFor('Kiran Das'), { type: 'name-typed', value: 'ആതിര', roll: 0 });
    expect(state.username).toBe('kiran-das');
  });

  it('swaps a suggestion the check finds taken for <handle>-NNN', () => {
    const state = run(stepFor('Kiran Das'), { type: 'checked', handle: 'kiran-das', check: taken, roll: 0.5 });
    expect(state.username).toBe('kiran-das-550');
    expect(state.suggestion).toEqual({ current: 'kiran-das-550', swaps: 1, taken: ['kiran-das'] });
    expect(state.swapNotice).toBe('kiran-das is taken. Suggested handle: kiran-das-550.');
  });

  it('gives up after three swaps, and the line then says the handle is taken', () => {
    let state = stepFor('Kiran Das');
    for (const roll of [0.1, 0.2, 0.3, 0.4]) {
      state = run(state, { type: 'checked', handle: state.username, check: taken, roll });
    }
    expect(state.suggestion?.swaps).toBe(3);
    expect(state.username).toBe('kiran-das-370');
    expect(describeHandleLine({ username: state.username, refusedAtSave: null, localRefusal: null, check: state.answer!.check }))
      .toEqual({ tone: 'error', text: 'That username is already taken.' });
  });

  it('ignores an answer about a handle the field no longer holds', () => {
    const state = run(
      stepFor('Kiran Das'),
      { type: 'name-typed', value: 'Kiran Das Kumar', roll: 0 },
      { type: 'checked', handle: 'kiran-das', check: taken, roll: 0.5 },
    );
    expect(state.username).toBe('kiran-das-kumar');
    expect(state.suggestion?.swaps).toBe(0);
  });

  it('brings a handle already found taken back numbered when the name is edited back', () => {
    const state = run(
      stepFor('Kiran Das'),
      { type: 'checked', handle: 'kiran-das', check: taken, roll: 0.5 },
      { type: 'name-typed', value: 'Kiran Dass', roll: 0 },
      { type: 'name-typed', value: 'Kiran Das', roll: 0.25 },
    );
    expect(state.username).toBe('kiran-das-325');
    expect(state.suggestion?.swaps).toBe(2);
  });

  // Owner, 2026-11-08: nothing moves under the cursor, even before the first key.
  it('changes nothing once the handle field has the cursor', () => {
    const focused = run(stepFor('Kiran Das'), { type: 'handle-focused' });
    const answered = run(focused, { type: 'checked', handle: 'kiran-das', check: taken, roll: 0.5 });
    expect(answered.username).toBe('kiran-das');
    expect(run(focused, { type: 'name-typed', value: 'Kiran Das Kumar', roll: 0 }).username).toBe('kiran-das');
    // A taken suggestion left untouched is swapped once the field is left.
    expect(run(answered, { type: 'handle-left', roll: 0.5 }).username).toBe('kiran-das-550');
  });

  it('holds the handle still while a save runs, and swaps once it ends', () => {
    const saving = run(stepFor('Kiran Das'), { type: 'save-started' }, { type: 'checked', handle: 'kiran-das', check: taken, roll: 0.5 });
    expect(saving.username).toBe('kiran-das');
    expect(run(saving, { type: 'save-ended', roll: 0.5 }).username).toBe('kiran-das-550');
  });

  it('treats anything typed in the handle field as the creator’s own', () => {
    const typed = run(stepFor('Kiran Das'), { type: 'handle-typed', value: '@Kiran_D!' });
    expect(typed.username).toBe('kirand');
    expect(typed.suggestion).toBeNull();
    const after = run(typed, { type: 'name-typed', value: 'Someone Else', roll: 0 }, { type: 'checked', handle: 'kirand', check: taken, roll: 0.5 });
    expect(after.username).toBe('kirand');
  });
});

describe('the line under the handle', () => {
  const line = (overrides: Partial<Parameters<typeof describeHandleLine>[0]>) => describeHandleLine({
    username: 'kiran-das',
    refusedAtSave: null,
    localRefusal: null,
    check: { state: 'idle' },
    ...overrides,
  });

  it('says the rule, then what the live check says', () => {
    expect(line({})).toEqual({ tone: 'rule', text: PUBLIC_HANDLE_RULE });
    expect(line({ check: { state: 'checking' } })).toEqual({ tone: 'checking', text: HANDLE_CHECKING_TEXT });
    expect(line({ check: { state: 'available' } })).toEqual({ tone: 'available', text: HANDLE_AVAILABLE_TEXT });
    expect(line({ check: taken })).toEqual({ tone: 'error', text: 'That username is already taken.' });
    expect(line({ check: { state: 'taken', message: '' } })).toEqual({ tone: 'error', text: HANDLE_UNAVAILABLE_TEXT });
  });

  it('puts the save’s refusal of this very handle, then the step’s own, before the check', () => {
    expect(line({ refusedAtSave: { handle: 'kiran-das', message: HANDLE_JUST_CLAIMED_TEXT }, check: { state: 'available' } }))
      .toEqual({ tone: 'error', text: HANDLE_JUST_CLAIMED_TEXT });
    // A refusal of an earlier handle is not this one's.
    expect(line({ refusedAtSave: { handle: 'kiran', message: HANDLE_JUST_CLAIMED_TEXT }, check: { state: 'available' } }).tone).toBe('available');
    expect(line({ localRefusal: 'That handle is reserved.', check: { state: 'available' } }))
      .toEqual({ tone: 'error', text: 'That handle is reserved.' });
  });

  it('refuses the placeholder and a reserved handle with no round trip, but not one still being typed', () => {
    expect(localHandleRefusal('admin', 'creator-a1b2c3d4')).toBe('That handle is reserved.');
    expect(localHandleRefusal('creator-a1b2c3d4', 'creator-a1b2c3d4')).toMatch(/creator-xxxxxxxx/);
    expect(localHandleRefusal('ki', null)).toBeNull();
    expect(localHandleRefusal('kiran-das', null)).toBeNull();
    // The account's own reserved handle stays its own.
    expect(localHandleRefusal('admin', 'admin')).toBeNull();
    expect(isWellFormedHandle('ki')).toBe(false);
    expect(isWellFormedHandle('kiran-das')).toBe(true);
  });
});

describe('Home opening the step again, once per browser session', () => {
  const base = {
    identity: PLACEHOLDER,
    userId: 'user-1',
    userMetadata: {},
    isGuest: false,
    shownFor: null,
  };

  it('opens it for an account without a creator name that has not seen it this session', () => {
    expect(shouldReopenCreatorNameStep(base)).toBe(true);
    // Shown in this session for this account: not again.
    expect(shouldReopenCreatorNameStep({ ...base, shownFor: 'user-1' })).toBe(false);
    // Shown for another account in this browser: this one is still asked.
    expect(shouldReopenCreatorNameStep({ ...base, shownFor: 'user-2' })).toBe(true);
  });

  it('leaves a named account, an earlier "Set up later", a guest and an unknown profile alone', () => {
    expect(shouldReopenCreatorNameStep({ ...base, identity: { username: 'kiran-das', displayName: 'Kiran Das' } })).toBe(false);
    expect(shouldReopenCreatorNameStep({ ...base, userMetadata: { creator_profile_onboarding_skipped_version: 1 } })).toBe(false);
    expect(shouldReopenCreatorNameStep({ ...base, isGuest: true })).toBe(false);
    expect(shouldReopenCreatorNameStep({ ...base, identity: null })).toBe(false);
  });

  it('marks the step shown with a session cookie that names the account', () => {
    expect(creatorNameStepShownCookie('user-1', true)).toBe('mb_name_step_shown=user-1; Path=/; SameSite=Lax; Secure');
    expect(creatorNameStepShownCookie('user 1', false)).toBe('mb_name_step_shown=user%201; Path=/; SameSite=Lax');
    expect(readCreatorNameStepShownFor('user%201')).toBe('user 1');
    expect(readCreatorNameStepShownFor(undefined)).toBeNull();
    expect(readCreatorNameStepShownFor('%E0%A4%A')).toBeNull();
  });
});

// The invite's outcome rides to the page the name step opens with `welcome=1`.
describe('the invite status on the way through the name step', () => {
  it('puts the status on the step’s next, hand-over nonce and hash kept', () => {
    expect(withReferralClaimStatus('/onboarding?next=%2Fcreate', 'applied')).toBe('/onboarding?next=%2Fcreate%3Freferral%3Dapplied');
    const throughCreator = withReferralClaimStatus('/onboarding?next=%2Fcreate-video%3Fhandover%3Dnonce-1234%23top', 'existing_account');
    const next = new URL(new URL(throughCreator, 'https://magicbooklet.local').searchParams.get('next')!, 'https://magicbooklet.local');
    expect(next.pathname).toBe('/create-video');
    expect(next.searchParams.get('handover')).toBe('nonce-1234');
    expect(next.searchParams.get('referral')).toBe('existing_account');
    expect(next.hash).toBe('#top');
  });

  it('carries nothing to a step without a safe next, or to an old first-profile link', () => {
    expect(withReferralClaimStatus('/onboarding', 'applied')).toBe('/onboarding');
    expect(withReferralClaimStatus('/onboarding?next=%2F%2Fattacker.example', 'applied')).toBe('/onboarding?next=%2F%2Fattacker.example');
    expect(withReferralClaimStatus('/profile?welcome=1&next=%2Fwelcome-reward', 'applied')).toBe('/profile?welcome=1&next=%2Fwelcome-reward');
    expect(withReferralClaimStatus('/onboarding?next=%2Fcreate', null)).toBe('/onboarding?next=%2Fcreate');
  });
});
