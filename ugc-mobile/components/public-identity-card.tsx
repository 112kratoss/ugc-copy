import { View } from 'react-native';

import { CompactFieldLabel, ComposerFieldShell, ComposerInput, FieldErrorText } from '@/components/composer-fields';
import { AppText } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import {
  normalizeUsernameInput,
  PROFILE_DISPLAY_NAME_MAX_LENGTH,
  PROFILE_USERNAME_MAX_LENGTH,
  PROFILE_USERNAME_RULE,
  usernameHint,
} from '@/lib/edit-profile-form';
import type { PublicIdentityDraft, PublicIdentityErrors } from '@/lib/public-identity';
import { useHandleAvailability } from '@/lib/use-handle-availability';

/**
 * The name and handle a public post shows, asked for on step 2 of a creator who
 * has neither yet, and in the sheet a list opens when such a creator makes a
 * post public. Publishing publicly saves them to the profile first, so the
 * post is never refused for them after the media is up.
 *
 * The handle is checked with the server as it is typed, as Edit profile and
 * onboarding check it, so a taken one shows here before the press.
 */
export function PublicIdentityCard({
  value,
  errors,
  editable,
  onChange,
  savedUsername,
  framed = true,
}: {
  value: PublicIdentityDraft;
  errors: PublicIdentityErrors;
  editable: boolean;
  onChange: (next: PublicIdentityDraft) => void;
  /** The profile's stored handle: the account's own claimed handle is never checked. */
  savedUsername?: string | null;
  /**
   * In the composer's panel, with a heading and a line on why both are asked
   * for. A sheet that says that in its own title draws the two fields alone.
   */
  framed?: boolean;
}) {
  const { api } = useAuth();
  const live = useHandleAvailability(api, { ...value, savedUsername });
  // The form's or the save's verdict comes first; then the server's word as it
  // is typed; else the rule, so the line under the field always says something.
  const hint = usernameHint({
    availability: live.availability,
    message: live.availability === 'available' ? 'This handle is available.' : live.message,
  });

  const fields = (
    <>
      <CompactFieldLabel label="Display name" required valueLength={value.displayName.length} maxLength={PROFILE_DISPLAY_NAME_MAX_LENGTH} />
      <ComposerInput
        accessibilityLabel="Display name, required"
        accessibilityHint="The name shown on your public posts."
        value={value.displayName}
        onChangeText={(displayName) => onChange({ ...value, displayName: displayName.slice(0, PROFILE_DISPLAY_NAME_MAX_LENGTH) })}
        placeholder="Your name"
        autoComplete="name"
        editable={editable}
      />
      <FieldErrorText message={errors.displayName} />
      <CompactFieldLabel label="Handle" required />
      <ComposerInput
        accessibilityLabel="Handle, required"
        accessibilityHint={`Your profile link: ${PROFILE_USERNAME_RULE}`}
        value={value.username}
        onChangeText={(username) => onChange({ ...value, username: normalizeUsernameInput(username).slice(0, PROFILE_USERNAME_MAX_LENGTH) })}
        placeholder="your-handle"
        autoCapitalize="none"
        autoCorrect={false}
        editable={editable}
      />
      {errors.username
        ? <FieldErrorText message={errors.username} />
        : (
          // Polite: the check answers a pause in typing, not a press.
          <AppText accessibilityLiveRegion="polite" variant="caption" color={hint.tone}>
            {hint.text}
          </AppText>
        )}
    </>
  );

  if (!framed) {
    return <View style={{ gap: 8 }}>{fields}</View>;
  }

  return (
    <ComposerFieldShell>
      <AppText variant="label">Your name and handle</AppText>
      <AppText variant="bodySm" color="muted">
        Public posts show both. They are saved to your profile when you publish, and you can change them there later.
      </AppText>
      {fields}
    </ComposerFieldShell>
  );
}
