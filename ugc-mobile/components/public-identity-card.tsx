import type { Ref } from 'react';
import { View } from 'react-native';

import { CompactFieldLabel, ComposerFieldShell, ComposerInput } from '@/components/composer-fields';
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
  fieldRefs,
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
  /** Each field, label to message: what the composer measures to bring a refused field into view. */
  fieldRefs?: Partial<Record<keyof PublicIdentityDraft, Ref<View>>>;
}) {
  const { api } = useAuth();
  const live = useHandleAvailability(api, { ...value, savedUsername });
  // The form's or the save's verdict comes first; then the server's word as it
  // is typed; else the rule, so the line under the field always says something.
  const hint = usernameHint({
    availability: live.availability,
    message: live.availability === 'available' ? 'This handle is available.' : live.message,
  });

  // Each field in a view of its own, spaced as the panel spaces its rows. A
  // verdict on a field is said on that field's line alone, in a polite live
  // region as Edit profile's and onboarding's lines are, so TalkBack reads a
  // save's refusal from there.
  const fields = (
    <>
      <View ref={fieldRefs?.displayName} testID="public-identity-display-name" style={{ gap: 8 }}>
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
        {errors.displayName ? (
          <AppText accessibilityRole="alert" accessibilityLiveRegion="polite" variant="caption" color="danger">
            {errors.displayName}
          </AppText>
        ) : null}
      </View>
      <View ref={fieldRefs?.username} testID="public-identity-username" style={{ gap: 8 }}>
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
        {/* One line for the hint and the verdict, so a verdict that replaces
            the hint is a change of the line TalkBack reads. Polite: the check
            answers a pause in typing, not a press. */}
        <AppText
          accessibilityRole={errors.username ? 'alert' : undefined}
          accessibilityLiveRegion="polite"
          variant="caption"
          color={errors.username ? 'danger' : hint.tone}
        >
          {errors.username ?? hint.text}
        </AppText>
      </View>
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
