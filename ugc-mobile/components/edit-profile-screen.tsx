import { useNavigation, usePreventRemove } from '@react-navigation/native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { Camera, Check, ImageIcon } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { KeyboardAvoidingArea } from '@/components/keyboard-aware';
import { AppText, AppTextInput, PrimaryButton, SecondaryButton, StatusBlock } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import {
  PROFILE_BIO_MAX_LENGTH,
  PROFILE_DISPLAY_NAME_MAX_LENGTH,
  PROFILE_USERNAME_MAX_LENGTH,
  type EditProfileFieldErrors,
  type UsernameAvailability,
  hasEditProfileChanges,
  normalizeUsername,
  normalizeUsernameInput,
  readUsernameRejection,
  shouldCheckUsernameAvailability,
  usernameHint,
  validateProfileField,
  validateProfileForm,
} from '@/lib/edit-profile-form';
import { getEditProfileScrollPadding } from '@/lib/edit-profile-layout';
import { uploadProfileImage } from '@/lib/media';
import { getProfileHandle, getProfileInitials, getProfileName } from '@/lib/profile-view-model';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { CloseGlyph } from '@/lib/platform-glyphs';
import { appTheme } from '@/lib/theme';
import type { ProfileResponse } from '@/lib/types';
import { haptic } from '@/lib/haptics';

/** Debounce before the availability round trip. The endpoint is rate limited. */
const USERNAME_CHECK_DELAY_MS = 400;

interface EditProfileForm {
  username: string;
  displayName: string;
  bio: string;
  avatarUrl: string;
  coverUrl: string;
}

const emptyForm: EditProfileForm = {
  username: '',
  displayName: '',
  bio: '',
  avatarUrl: '',
  coverUrl: '',
};

export function EditProfileScreen() {
  const { user, api, refreshProfile } = useAuth();
  const queryClient = useQueryClient();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const scrollBottomPadding = getEditProfileScrollPadding({ bottomInset });
  const pageWidth = Math.min(width, 430);
  const isCompact = pageWidth < 390;
  const horizontalPadding = isCompact ? 16 : 20;

  const [form, setForm] = useState<EditProfileForm>(emptyForm);
  const [avatarDraftUri, setAvatarDraftUri] = useState<string | null>(null);
  const [coverDraftUri, setCoverDraftUri] = useState<string | null>(null);
  const [avatarAsset, setAvatarAsset] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const [coverAsset, setCoverAsset] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const [fieldErrors, setFieldErrors] = useState<EditProfileFieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [photoAccessDenied, setPhotoAccessDenied] = useState(false);
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const [usernameAvailability, setUsernameAvailability] = useState<UsernameAvailability>('idle');
  const [usernameMessage, setUsernameMessage] = useState<string | null>(null);
  // Set once the screen is done with the changes, so the unsaved-work guard
  // below lets a successful save — or an accepted discard — navigate away.
  const [isLeaveAllowed, setIsLeaveAllowed] = useState(false);
  // Return advances through the form rather than dismissing the keyboard.
  const usernameRef = useRef<TextInput | null>(null);
  const bioRef = useRef<TextInput | null>(null);

  const profileQuery = useQuery({
    queryKey: ['profile', user?.id],
    enabled: Boolean(user),
    queryFn: api.getProfile,
  });

  useEffect(() => {
    if (profileQuery.data) {
      setForm(formFromProfile(profileQuery.data));
      setAvatarDraftUri(null);
      setCoverDraftUri(null);
      setAvatarAsset(null);
      setCoverAsset(null);
      setFieldErrors({});
      setMessage(null);
      setPhotoAccessDenied(false);
      setProgressMessage(null);
      setUsernameAvailability('idle');
      setUsernameMessage(null);
    }
  }, [profileQuery.data]);

  const profile = profileQuery.data;

  /**
   * The live preview of what the two identity fields will produce — the handle
   * in particular, which is the normalised form of what was typed rather than
   * the typing itself.
   */
  const preview = useMemo(() => {
    const base = profile ?? emptyProfile(user?.id ?? 'preview');
    const identity = {
      ...base,
      username: normalizeUsername(form.username) || base.username || base.suggestedUsername || null,
      displayName: form.displayName || null,
    };
    return {
      name: getProfileName({ ...identity, bio: form.bio || null }, user?.email),
      handle: getProfileHandle(identity, user?.email),
      initials: getProfileInitials(identity, user?.email),
    };
  }, [form.bio, form.displayName, form.username, profile, user?.email, user?.id]);

  const initialForm = useMemo(() => (profile ? formFromProfile(profile) : emptyForm), [profile]);
  const hasProfileChanges = hasEditProfileChanges({
    current: form,
    initial: initialForm,
    hasAvatarDraft: Boolean(avatarAsset),
    hasCoverDraft: Boolean(coverAsset),
  });

  /**
   * The availability check onboarding already runs on this same handle. Without
   * it a taken username was only discovered by `saveProfile` — which uploads
   * the avatar and the cover *before* it PATCHes the profile, so the answer
   * arrived after two uploads had run for nothing.
   */
  useEffect(() => {
    if (!shouldCheckUsernameAvailability({
      value: form.username,
      displayName: form.displayName,
      savedUsername: profile?.username,
    })) {
      setUsernameAvailability('idle');
      setUsernameMessage(null);
      return;
    }

    setUsernameAvailability('checking');
    const timer = setTimeout(() => {
      void api.validateProfile({
        username: normalizeUsername(form.username),
        displayName: form.displayName.trim(),
      })
        .then(() => {
          setUsernameAvailability('available');
          setUsernameMessage(null);
        })
        .catch((error) => {
          const rejection = readUsernameRejection(error);
          if (!rejection) {
            // Offline, rate limited, or a server fault: no verdict on the name.
            setUsernameAvailability('idle');
            setUsernameMessage(null);
            return;
          }
          setUsernameAvailability('taken');
          setUsernameMessage(rejection);
        });
    }, USERNAME_CHECK_DELAY_MS);

    return () => clearTimeout(timer);
  }, [api, form.displayName, form.username, profile?.username]);

  const saveMutation = useMutation({
    mutationFn: saveProfile,
    onMutate: () => {
      setMessage(null);
      setProgressMessage('Preparing your changes…');
    },
    onSuccess: async () => {
      await refreshProfile();
      await queryClient.invalidateQueries({ queryKey: ['profile'] });
      haptic.success();
      leaveWithChangesSettled();
    },
    onError: async (error) => {
      setProgressMessage(null);
      if (error instanceof ApiError) {
        const details = error.details as { fieldErrors?: EditProfileFieldErrors } | undefined;
        if (details?.fieldErrors) {
          setFieldErrors((current) => ({ ...current, ...details.fieldErrors }));
        }
      }
      setMessage(error instanceof Error ? error.message : 'Profile could not be saved.');
      haptic.error();
    },
    onSettled: () => {
      setProgressMessage(null);
    },
  });

  const isSaving = saveMutation.isPending;
  const canSave = hasProfileChanges
    && profileQuery.isSuccess
    && Boolean(profile)
    && usernameAvailability !== 'taken';

  /**
   * Modality: "if closing a modal could result in loss of user-generated
   * content, present an alert" — and this route is `presentation: 'modal'`, so
   * the swipe-down discards the form too. One guard covers the Close control,
   * the dismiss gesture and Android's hardware back; the composer's leave sheet
   * is the same shape, minus the draft this screen has nowhere to keep.
   */
  usePreventRemove(hasProfileChanges && !isLeaveAllowed && !isSaving, ({ data }) => {
    // `Alert`, not the app's action sheet, for two reasons that agree. Alerts
    // is what one destructive confirmation is for — `lib/action-sheet.ts` says
    // so itself, and the composer's sheet is a sheet because it has a second
    // choice (save the draft) that this screen has nowhere to keep. And the
    // sheet could not appear here anyway: `ActionSheetHost` is an in-window
    // overlay by design (an RN Modal cannot report keyboard height on Android),
    // and this route is `presentation: 'modal'` — a native modal presented
    // above that window. Captured on the simulator: the screen was correctly
    // held, and the sheet was nowhere, which traps a person on the form.
    // "Keep editing" rather than "Cancel": the control they just pressed is
    // named Cancel, so a Cancel that means *stay* reverses itself (ledger DV8).
    Alert.alert('Discard your changes?', undefined, [
      { text: 'Keep editing', style: 'cancel' },
      {
        text: 'Discard',
        style: 'destructive',
        onPress: () => {
          setIsLeaveAllowed(true);
          setTimeout(() => navigation.dispatch(data.action), 0);
        },
      },
    ]);
  });

  async function pickProfileImage(role: 'avatar' | 'cover') {
    setMessage(null);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      // Not a save failure — the old copy filed it under "Profile not saved",
      // which named the wrong thing and offered no way to change the answer.
      setPhotoAccessDenied(true);
      return;
    }
    setPhotoAccessDenied(false);

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: role === 'avatar' ? [1, 1] : [16, 9],
      quality: 0.9,
    });

    if (result.canceled || !result.assets[0]) {
      return;
    }

    const asset = result.assets[0];
    if (role === 'avatar') {
      setAvatarAsset(asset);
      setAvatarDraftUri(asset.uri);
      setFieldErrors((current) => ({ ...current, avatarUrl: undefined }));
    } else {
      setCoverAsset(asset);
      setCoverDraftUri(asset.uri);
      setFieldErrors((current) => ({ ...current, coverUrl: undefined }));
    }
  }

  async function saveProfile() {
    if (!user) {
      throw new Error('Sign in before editing your profile.');
    }
    if (!profile) {
      throw new Error('Load your profile before saving changes.');
    }

    const validationErrors = validateProfileForm(form);
    setFieldErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) {
      throw new Error('Fix the highlighted profile fields.');
    }

    let avatarUrl = form.avatarUrl || null;
    let coverUrl = form.coverUrl || null;

    if (avatarAsset) {
      setProgressMessage('Uploading display photo…');
      avatarUrl = await uploadProfileImage(avatarAsset.uri, {
        api,
        role: 'avatar',
        fileName: avatarAsset.fileName,
        mimeType: avatarAsset.mimeType,
        sizeBytes: avatarAsset.fileSize,
      });
    }

    if (coverAsset) {
      setProgressMessage('Uploading background picture…');
      coverUrl = await uploadProfileImage(coverAsset.uri, {
        api,
        role: 'cover',
        fileName: coverAsset.fileName,
        mimeType: coverAsset.mimeType,
        sizeBytes: coverAsset.fileSize,
      });
    }

    setProgressMessage('Saving profile…');
    await api.updateProfile({
      username: normalizeUsername(form.username),
      displayName: form.displayName,
      bio: form.bio,
      avatarUrl,
      coverUrl,
      websiteUrl: profile.websiteUrl ?? null,
      twitterHandle: profile.twitterHandle ?? null,
      instagramHandle: profile.instagramHandle ?? null,
      tiktokHandle: profile.tiktokHandle ?? null,
      location: profile.location ?? null,
    });
  }

  function editField(field: 'username' | 'displayName' | 'bio', value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
  }

  /**
   * Text fields: "when creating a user name or password, validation needs to
   * happen before people switch to another field."
   */
  function validateOnBlur(field: 'username' | 'displayName' | 'bio') {
    setFieldErrors((current) => ({ ...current, [field]: validateProfileField(field, form[field]) }));
  }

  /**
   * What the Close control does: *ask* to leave. It must not clear
   * `isLeaveAllowed` first — doing so disarms the guard above, and the first
   * capture of this screen showed exactly that, the form closing to Home with
   * the edits gone and no confirmation.
   */
  function requestLeave() {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)/profile' as never);
    }
  }

  /** Leaving with the work settled: nothing left to confirm. */
  function leaveWithChangesSettled() {
    setIsLeaveAllowed(true);
    setTimeout(requestLeave, 0);
  }

  const header = (
    <EditHeader
      isSaving={isSaving}
      topInset={topInset}
      onClose={requestLeave}
      onSave={canSave ? () => saveMutation.mutate() : undefined}
    />
  );

  if (!user) {
    return (
      <EditProfileShell header={header} scrollBottomPadding={scrollBottomPadding} horizontalPadding={horizontalPadding}>
        <StatusBlock title="Sign in required" body="Sign in to update your Magicbooklet profile." />
        <PrimaryButton label="Sign in" accent="primary" onPress={() => router.replace('/auth' as never)} />
      </EditProfileShell>
    );
  }

  const username = usernameHint({ availability: usernameAvailability, message: usernameMessage });

  return (
    <EditProfileShell header={header} scrollBottomPadding={scrollBottomPadding} horizontalPadding={horizontalPadding}>
      {profileQuery.isLoading ? (
        <View style={{ minHeight: 360, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={appTheme.colors.primary} />
        </View>
      ) : profileQuery.isError || !profile ? (
        <View style={{ gap: appTheme.spacing.gap }}>
          <StatusBlock tone="danger" title="Could not load profile" body="Nothing can be changed until your current profile loads. Check your connection, then try again." />
          <SecondaryButton label="Retry profile" onPress={() => void profileQuery.refetch()} />
        </View>
      ) : (
        <>
          {progressMessage ? <StatusBlock tone="info" title="Updating profile" body={progressMessage} /> : null}
          {message ? <StatusBlock tone="danger" title="Profile not saved" body={message} /> : null}
          {photoAccessDenied ? (
            <View style={{ gap: appTheme.spacing.gap }}>
              <StatusBlock
                tone="warning"
                title="Photo access is off"
                body="Magicbooklet cannot open your photo library. Allow photo access in system settings to choose a display photo or cover."
              />
              <SecondaryButton label="Settings" onPress={() => { void Linking.openSettings(); }} />
            </View>
          ) : null}

          <View style={{ gap: 0 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Change cover"
              onPress={() => pickProfileImage('cover')}
              style={({ pressed }) => ({
                height: isCompact ? 148 : 164,
                borderRadius: appTheme.radii.xl,
                borderCurve: 'continuous',
                overflow: 'hidden',
                borderWidth: 1,
                borderColor: fieldErrors.coverUrl ? appTheme.colors.danger : appTheme.colors.border,
                backgroundColor: appTheme.colors.panel,
                opacity: pressed ? appTheme.opacity.pressed : 1,
              })}
            >
              {coverDraftUri || form.coverUrl ? (
                <Image source={{ uri: coverDraftUri ?? form.coverUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
              ) : (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: appTheme.colors.panelSoft }}>
                  <ImageIcon size={appTheme.icon.hero} color={appTheme.colors.muted} />
                  <AppText variant="label" color="muted">Add a cover image</AppText>
                </View>
              )}
              <LinearGradient colors={['rgba(3,4,13,0.08)', 'rgba(3,4,13,0.76)']} style={{ position: 'absolute', inset: 0 }} />
              <View style={{ position: 'absolute', right: 14, bottom: 14 }}>
                <ActionPill icon={<ImageIcon size={appTheme.icon.sm} color={appTheme.colors.text} />} label="Change cover" />
              </View>
            </Pressable>

            {/*
              The name and handle used to sit inside the cover at `bottom: 18`,
              where the avatar's `marginTop: -36` landed squarely on the handle —
              captured on the simulator with only the "@" showing. They read
              below the avatar row now, which is where the profile this previews
              puts them (`profile-dashboard`'s hero card), and they get the full
              width instead of the strip left over beside the pill.
            */}
            <View style={{ marginTop: -36, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 14 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Change display photo"
                onPress={() => pickProfileImage('avatar')}
                style={({ pressed }) => ({
                  width: 84,
                  height: 84,
                  borderRadius: 42,
                  padding: 3,
                  borderWidth: 2,
                  borderColor: appTheme.colors.primary,
                  backgroundColor: appTheme.colors.background,
                  opacity: pressed ? appTheme.opacity.pressed : 1,
                })}
              >
                  <View style={{ flex: 1, overflow: 'hidden', borderRadius: 38, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.panelSoft }}>
                    {avatarDraftUri || form.avatarUrl ? (
                      <Image source={{ uri: avatarDraftUri ?? form.avatarUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
                    ) : (
                      <AppText variant="sectionTitle">{preview.initials}</AppText>
                    )}
                  </View>
                <View style={{ position: 'absolute', right: -2, bottom: 0, width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.primary, borderWidth: 3, borderColor: appTheme.colors.background }}>
                  <Camera size={appTheme.icon.sm} color={appTheme.colors.onPrimary} />
                </View>
              </Pressable>
              <AppText variant="caption" color="muted" style={{ paddingBottom: 12 }}>Tap photo to replace</AppText>
            </View>

            <View style={{ paddingHorizontal: 4, paddingTop: 12, gap: 4 }}>
              <AppText variant="sectionTitle" numberOfLines={1}>{preview.name}</AppText>
              <AppText variant="label" color="primary" numberOfLines={1}>{preview.handle}</AppText>
            </View>

            {fieldErrors.avatarUrl || fieldErrors.coverUrl ? (
              <View style={{ paddingHorizontal: 4, paddingTop: 10, gap: 4 }}>
                {fieldErrors.avatarUrl ? <FieldError text={fieldErrors.avatarUrl} /> : null}
                {fieldErrors.coverUrl ? <FieldError text={fieldErrors.coverUrl} /> : null}
              </View>
            ) : null}
          </View>

          <GlassForm>
            <AppTextInput
              label="Display name"
              value={form.displayName}
              onChangeText={(displayName) => editField('displayName', displayName)}
              onBlur={() => validateOnBlur('displayName')}
              onClear={() => editField('displayName', '')}
              error={fieldErrors.displayName}
              placeholder="LunaDreams"
              maxLength={PROFILE_DISPLAY_NAME_MAX_LENGTH}
              autoCapitalize="words"
              autoComplete="name"
              textContentType="name"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => usernameRef.current?.focus()}
            />
            <AppTextInput
              label="Username"
              value={form.username}
              // Lowercased, `@`-stripped and filtered as you type, the way the
              // onboarding screen that claims this same handle already does it.
              onChangeText={(next) => editField('username', normalizeUsernameInput(next))}
              onBlur={() => validateOnBlur('username')}
              onClear={() => editField('username', '')}
              error={fieldErrors.username}
              hint={fieldErrors.username ? undefined : username.text}
              hintTone={username.tone}
              placeholder="lunadreams"
              maxLength={PROFILE_USERNAME_MAX_LENGTH}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              textContentType="nickname"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => bioRef.current?.focus()}
              inputRef={usernameRef}
            />
            <AppTextInput
              label="Bio"
              value={form.bio}
              onChangeText={(bio) => editField('bio', bio)}
              onBlur={() => validateOnBlur('bio')}
              error={fieldErrors.bio}
              placeholder="Fantasy worlds, motion stories, and AI art experiments."
              multiline
              maxLength={PROFILE_BIO_MAX_LENGTH}
              footer={`${form.bio.length}/${PROFILE_BIO_MAX_LENGTH}`}
              inputRef={bioRef}
            />
          </GlassForm>
        </>
      )}
    </EditProfileShell>
  );
}

function EditProfileShell({
  children,
  header,
  scrollBottomPadding,
  horizontalPadding,
}: {
  children: React.ReactNode;
  header: React.ReactNode;
  scrollBottomPadding: number;
  horizontalPadding: number;
}) {
  return (
    <View style={{ flex: 1, backgroundColor: appTheme.colors.background }}>
      {header}
      <KeyboardAvoidingArea iosScrollViewAdjustsInsets>
      <ScrollView
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingTop: 16,
          paddingHorizontal: horizontalPadding,
          paddingBottom: scrollBottomPadding,
          gap: 18,
        }}
      >
        {children}
      </ScrollView>
      </KeyboardAvoidingArea>
    </View>
  );
}

/**
 * Pinned above the scroll view, the way the post composer's header is. It used
 * to be the scroll view's first child, so the screen's title and its only Save
 * control scrolled off as soon as you reached the bio — the field furthest from
 * the button that commits it.
 */
function EditHeader({
  isSaving,
  topInset,
  onClose,
  onSave,
}: {
  isSaving: boolean;
  topInset: number;
  onClose: () => void;
  onSave?: () => void;
}) {
  const disabled = !onSave || isSaving;

  return (
    <View
      style={{
        paddingTop: Math.max(8, topInset),
        paddingHorizontal: 14,
        paddingBottom: 8,
        borderBottomWidth: 1,
        borderBottomColor: appTheme.colors.borderSubtle,
        backgroundColor: appTheme.colors.background,
      }}
    >
      <View style={{ minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        {/*
          Named Cancel rather than Close, and pinned that way by N2's guard:
          Sheets asks a Done button to be "paired with a Cancel button", and
          Save is this sheet's Done. The duplication that used to sit under this
          — a second control, also called Cancel, at the foot of the form — was
          the real defect, and it is the one that went.
        */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          accessibilityState={{ disabled: isSaving }}
          disabled={isSaving}
          onPress={onClose}
          style={({ pressed }) => ({
            width: appTheme.touch.default,
            height: appTheme.touch.default,
            borderRadius: appTheme.touch.default / 2,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: pressed ? appTheme.colors.surfaceStrong : 'transparent',
            opacity: isSaving ? appTheme.opacity.disabled : 1,
          })}
        >
          <CloseGlyph size={appTheme.icon.feature} color={appTheme.colors.text} />
        </Pressable>
        <AppText heading variant="cardTitle" accessibilityRole="header" numberOfLines={1} style={{ flex: 1 }}>
          Edit profile
        </AppText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save profile"
          accessibilityState={{ disabled, busy: isSaving }}
          disabled={disabled}
          onPress={onSave}
          style={({ pressed }) => ({
            minWidth: 92,
            minHeight: appTheme.touch.default,
            borderRadius: appTheme.radii.pill,
            paddingHorizontal: 14,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 7,
            backgroundColor: disabled
              ? appTheme.colors.panelSoft
              : pressed ? appTheme.colors.primaryStrong : appTheme.colors.primary,
            opacity: disabled ? appTheme.opacity.disabled : 1,
          })}
        >
          {/*
            Buttons: "you can also configure the button to display a different
            label alongside the activity indicator ... 'Checkout' could change to
            'Checking out…'". It used to spin beside a label still reading Save.
          */}
          {isSaving
            ? <ActivityIndicator color={appTheme.colors.onPrimary} size="small" />
            : <Check size={appTheme.icon.sm} color={disabled ? appTheme.colors.text : appTheme.colors.onPrimary} />}
          <AppText variant="button" color={disabled ? 'text' : appTheme.colors.onPrimary}>
            {isSaving ? 'Saving…' : 'Save'}
          </AppText>
        </Pressable>
      </View>
    </View>
  );
}

function GlassForm({ children }: { children: React.ReactNode }) {
  return (
    <View
      style={{
        gap: 16,
        borderRadius: appTheme.radii.xl,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: appTheme.colors.border,
        backgroundColor: appTheme.colors.panel,
        padding: 16,
      }}
    >
      {children}
    </View>
  );
}

function ActionPill({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <View style={{ minHeight: appTheme.touch.default, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: appTheme.radii.pill, backgroundColor: appTheme.colors.overlayStrong, paddingHorizontal: 14, paddingVertical: 9 }}>
      {icon}
      <AppText variant="label">{label}</AppText>
    </View>
  );
}

function FieldError({ text }: { text: string }) {
  return (
    <AppText accessibilityRole="alert" accessibilityLiveRegion="polite" variant="caption" color="danger">
      {text}
    </AppText>
  );
}

function formFromProfile(profile: ProfileResponse): EditProfileForm {
  return {
    username: profile.username ?? profile.suggestedUsername ?? '',
    displayName: profile.displayName ?? '',
    bio: profile.bio ?? '',
    avatarUrl: profile.avatarUrl ?? '',
    coverUrl: profile.coverUrl ?? '',
  };
}

function emptyProfile(id: string): ProfileResponse {
  return {
    id,
    username: null,
    suggestedUsername: null,
    displayName: null,
    bio: null,
    avatarUrl: null,
    coverUrl: null,
    websiteUrl: null,
    twitterHandle: null,
    instagramHandle: null,
    tiktokHandle: null,
    location: null,
    credits: null,
  };
}
