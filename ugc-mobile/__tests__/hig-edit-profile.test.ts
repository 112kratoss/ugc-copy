import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ApiError } from '../lib/api-client';
import {
  PROFILE_USERNAME_MAX_LENGTH,
  normalizeUsernameInput,
  readUsernameRejection,
  shouldCheckUsernameAvailability,
  usernameHint,
  validateProfileField,
  validateProfileForm,
} from '../lib/edit-profile-form';

const mobileRoot = path.resolve(__dirname, '..');

function file(relativePath: string) {
  return readFileSync(path.join(mobileRoot, relativePath), 'utf8');
}

const screen = file('components/edit-profile-screen.tsx');

/** The block the "Change cover" control draws, from its label to its close tag. */
function coverControlSource() {
  const start = screen.indexOf('accessibilityLabel="Change cover"');
  expect(start).toBeGreaterThan(-1);
  const end = screen.indexOf('</Pressable>', start);
  expect(end).toBeGreaterThan(start);
  return screen.slice(start, end);
}

describe('HIG S15 — the profile form validates as you type', () => {
  it('normalises the username on every keystroke, the way onboarding does', () => {
    // Entering data prefers a field that cannot take a bad value over one that
    // reports it afterwards, and the onboarding screen that claims this same
    // handle already worked this way.
    expect(normalizeUsernameInput('@LunaDreams')).toBe('lunadreams');
    expect(normalizeUsernameInput('Luna Dreams!')).toBe('lunadreams');
    expect(normalizeUsernameInput('luna-dreams-2')).toBe('luna-dreams-2');
    expect(screen).toContain('normalizeUsernameInput(next)');
  });

  it('caps the username field at the length the API enforces', () => {
    // It had no maxLength at all: you could type sixty characters and only be
    // told at save time, after both images had uploaded.
    expect(PROFILE_USERNAME_MAX_LENGTH).toBe(24);
    expect(screen).toContain('maxLength={PROFILE_USERNAME_MAX_LENGTH}');
    expect(screen).toContain('maxLength={PROFILE_DISPLAY_NAME_MAX_LENGTH}');
    expect(screen).toContain('maxLength={PROFILE_BIO_MAX_LENGTH}');
  });

  it('requires a display name, which the server has always required', () => {
    expect(validateProfileField('displayName', '   ')).toBe('Add a display name for your public profile.');
    expect(validateProfileField('displayName', 'Luna')).toBeUndefined();
  });

  it('names what is wrong with a username rather than only reddening it', () => {
    expect(validateProfileField('username', '')).toBe('Choose a username for your profile.');
    expect(validateProfileField('username', 'ab')).toContain('3–24 lowercase letters');
    expect(validateProfileField('username', 'lunadreams')).toBeUndefined();
  });

  it('checks every field on blur and again on save, from one rule set', () => {
    // Text fields: "when creating a user name or password, validation needs to
    // happen before people switch to another field."
    for (const field of ['displayName', 'username', 'bio']) {
      expect(screen).toContain(`onBlur={() => validateOnBlur('${field}')}`);
    }
    expect(screen).toContain('validateProfileField(field, form[field])');
    expect(screen).toContain('validateProfileForm(form)');
  });

  it('asks the server about a username before the images upload, not after', () => {
    expect(screen).toContain('shouldCheckUsernameAvailability(');
    expect(screen).toContain('api.validateProfile(');
    // Debounced, because the endpoint is rate limited.
    expect(screen).toContain('USERNAME_CHECK_DELAY_MS');
    expect(screen).toMatch(/const USERNAME_CHECK_DELAY_MS = \d+/);
  });

  it('spends no round trip on a username that cannot need one', () => {
    const saved = { savedUsername: 'lunadreams', displayName: 'Luna' };
    expect(shouldCheckUsernameAvailability({ value: 'lunadreams', ...saved })).toBe(false);
    expect(shouldCheckUsernameAvailability({ value: '@LunaDreams', ...saved })).toBe(false);
    expect(shouldCheckUsernameAvailability({ value: 'ab', ...saved })).toBe(false);
    expect(shouldCheckUsernameAvailability({ value: 'newname', ...saved })).toBe(true);
    // A blank display name makes the whole submission invalid, so the answer
    // would say nothing about the name.
    expect(shouldCheckUsernameAvailability({ value: 'newname', savedUsername: 'lunadreams', displayName: '' })).toBe(false);
  });

  it('treats only a verdict as a verdict', () => {
    // Offline and rate limited are not "taken", and reading them as taken would
    // block the save for a name that is free.
    expect(readUsernameRejection(new Error('Network request failed'))).toBeNull();
    expect(readUsernameRejection(new ApiError('Too many requests', 429))).toBeNull();
    expect(readUsernameRejection(new ApiError('Failed to validate username', 500))).toBeNull();
    expect(readUsernameRejection(new ApiError('That username is already taken.', 409))).toBe('That username is already taken.');
    expect(readUsernameRejection(new ApiError('Please fix the highlighted fields.', 400, {
      fieldErrors: { username: 'Choose a custom handle instead of the reserved creator-xxxxxxxx format.' },
    }))).toContain('reserved creator-xxxxxxxx');
    // A 400 about some other field is not a username problem.
    expect(readUsernameRejection(new ApiError('Please fix the highlighted fields.', 400, {
      fieldErrors: { displayName: 'Add a display name for your public profile.' },
    }))).toBeNull();
  });

  it('says what the field wants when it has nothing else to report', () => {
    // Entering data: "be clear about the data you need."
    expect(usernameHint({ availability: 'idle' })).toEqual({
      text: '3–24 lowercase letters, numbers, or hyphens.',
      tone: 'muted',
    });
    expect(usernameHint({ availability: 'checking' }).text).toBe('Checking availability…');
    expect(usernameHint({ availability: 'available' }).tone).toBe('success');
    expect(usernameHint({ availability: 'taken', message: 'That username is already taken.' })).toEqual({
      text: 'That username is already taken.',
      tone: 'danger',
    });
  });

  it('will not save over a username the server has already refused', () => {
    expect(screen).toContain("usernameAvailability !== 'taken'");
  });

  it('finds nothing wrong with a complete form', () => {
    expect(validateProfileForm({ username: 'lunadreams', displayName: 'Luna', bio: 'Worlds.' })).toEqual({});
  });
});

describe('HIG S15 — the form is the app’s form', () => {
  it('draws the shared field rather than its own', () => {
    // The screen had a private `ProfileTextField` with no focus ring, no
    // selection colour and its own label idiom — the S2 finding, on the app's
    // other form.
    expect(screen).not.toContain('function ProfileTextField');
    // All three fields, and no hand-rolled one beside them. (`TextInput` still
    // appears as the type of the two focus refs; only a rendered one counts.)
    expect(screen.match(/<AppTextInput\b/g)).toHaveLength(3);
    expect(screen).not.toMatch(/<TextInput\n|<TextInput ref=/);
  });

  it('gives the shared field the states this form needed', () => {
    // Systemic, so every later form inherits them rather than rebuilding them.
    const ui = file('components/ui.tsx');
    expect(ui).toContain('error?: string;');
    expect(ui).toContain('footer?: string;');
    expect(ui).toContain('onClear?: () => void;');
    expect(ui).toContain('aria-invalid={Boolean(error)}');
    expect(ui).toContain("accessibilityRole={error ? 'alert' : undefined}");
  });

  it('clears a field from inside it, on both platforms', () => {
    // Text fields, iOS: "Display a Clear button in the trailing end of a text
    // field to help people erase their input." Drawn, not `clearButtonMode`,
    // which is iOS-only.
    const ui = file('components/ui.tsx');
    expect(ui).toContain('const FIELD_CONTROL_SIZE = MIN_HIT_TARGET_PT;');
    expect(ui).toContain('accessibilityLabel={`Clear ${label.toLowerCase()}`}');
    expect(ui).not.toMatch(/clearButtonMode=/);
    // Only where there is something to clear, and never on the multiline field,
    // where it would sit over the text.
    expect(ui).toContain('const showClear = Boolean(onClear) && !multiline && !disabled && Boolean(value);');
    expect(screen).toContain("onClear={() => editField('displayName', '')}");
    expect(screen).toContain("onClear={() => editField('username', '')}");
  });
});

describe('HIG S15 — the way out and the way through', () => {
  it('confirms before the modal throws away the form', () => {
    // Modality: "if closing a modal could result in loss of user-generated
    // content, present an alert". The route is `presentation: 'modal'`, so the
    // swipe-down discards it too — one guard covers the control, the gesture
    // and Android's hardware back.
    expect(screen).toContain('usePreventRemove(');
    expect(screen).toContain("Alert.alert('Discard your changes?'");
    expect(screen).toContain("style: 'destructive'");
    expect(screen).toContain("text: 'Keep editing', style: 'cancel'");
    expect(file('app/_layout.tsx')).toContain('name="edit-profile" options={{ headerShown: false, presentation: \'modal\'');
  });

  it('keeps the custom action sheet off routes it cannot appear over', () => {
    // `ActionSheetHost` is an in-window overlay on purpose — an RN Modal
    // reports no keyboard height on Android — so it draws inside the root view
    // controller and a `presentation: 'modal'` route is presented above it.
    // Calling `showActionSheet` from one holds the screen and shows nothing,
    // which traps the person on the form. `Alert` is presented by the OS and
    // does appear. Captured on the simulator before this fix.
    const layout = file('app/_layout.tsx');
    const modalRoutes = [...layout.matchAll(/name="([^"]+)"[^>]*?presentation: 'modal'/gs)].map((m) => m[1]);
    // A new modal route lands here deliberately, so whoever adds it reads this.
    expect(modalRoutes.sort()).toEqual(['auth', 'edit-profile']);
    expect(screen).not.toContain('showActionSheet');
    expect(file('app/auth.tsx')).not.toContain('showActionSheet');
  });

  it('does not let the Close control disarm the guard it should trip', () => {
    // It did, in the first build of this fix: Close called the helper that sets
    // `isLeaveAllowed` before navigating, so the screen closed to Home with the
    // edits gone and no confirmation. Only a completed save, and the discard
    // the sheet offers, may set that flag.
    expect(screen).toContain('onClose={requestLeave}');
    expect(screen).not.toContain('onClose={leaveWithChangesSettled}');
    const requestLeaveBody = screen.slice(
      screen.indexOf('function requestLeave()'),
      screen.indexOf('function leaveWithChangesSettled()')
    );
    expect(requestLeaveBody).not.toContain('setIsLeaveAllowed');
  });

  it('offers one way out, not two under two names', () => {
    // The header control and a footer button both called Cancel, 500pt apart.
    expect(screen).toContain('accessibilityLabel="Cancel"');
    expect(screen).not.toContain('label="Cancel"');
  });

  it('keeps the title and the Save control on screen while you type', () => {
    // The header was the scroll view's first child, so it left the screen as
    // soon as you reached the bio — the field furthest from the button that
    // commits it. Pinned above the scroller now, like the post composer's.
    const headerAt = screen.indexOf('{header}');
    const scrollAt = screen.indexOf('<ScrollView');
    expect(headerAt).toBeGreaterThan(-1);
    expect(headerAt).toBeLessThan(scrollAt);
  });

  it('answers to the name of the control that opens it', () => {
    // The control's spoken name was already "Edit profile"; the name it drew
    // and the title of the screen it opened were both "Edit Profile". All three
    // now say the same thing.
    expect(screen).toContain('Edit profile');
    expect(screen).not.toContain('Edit Profile');
    const dashboard = file('components/profile-dashboard.tsx');
    expect(dashboard).toContain('accessibilityLabel="Edit profile"');
    expect(dashboard).toContain('>Edit profile</Text>');
    expect(dashboard).not.toContain('Edit Profile');
  });

  it('says it is saving rather than spinning beside the word Save', () => {
    // Buttons: "the label 'Checkout' could change to 'Checking out…'".
    expect(screen).toContain("{isSaving ? 'Saving…' : 'Save'}");
  });
});

describe('HIG S15 — the hero preview', () => {
  it('keeps the identity preview out from under the avatar', () => {
    // The handle sat at `bottom: 18` inside the cover and the avatar's
    // `marginTop: -36` landed on it: captured on the simulator with only the
    // "@" showing. It reads below the avatar row now, where the profile this
    // previews puts it.
    const cover = coverControlSource();
    expect(cover).not.toContain('preview.name');
    expect(cover).not.toContain('preview.handle');
    expect(screen).toContain('{preview.name}');
    expect(screen).toContain('{preview.handle}');
  });

  it('does not file a declined photo permission as a failed save', () => {
    // It used to set the same `message` the save failure uses, so declining
    // photo access was reported under the title "Profile not saved".
    expect(screen).toContain('setPhotoAccessDenied(true)');
    expect(screen).toContain("title=\"Photo access is off\"");
    // And it offers the only place the answer can be changed — the same
    // treatment the alerts screen gives a denied notification permission.
    expect(screen).toContain('Linking.openSettings()');
  });
});
