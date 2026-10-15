import { useNavigation, usePreventRemove } from '@react-navigation/native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { Camera, Check, ImageIcon } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { KeyboardAvoidingArea } from '@/components/keyboard-aware';
import { AppText, AppTextInput, PrimaryButton, SecondaryButton, StatusBlock } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { showConfirmDialog } from '@/lib/dialog';
import {
  EMPTY_EDIT_PROFILE_FORM,
  PROFILE_BIO_MAX_LENGTH,
  PROFILE_DISPLAY_NAME_MAX_LENGTH,
  PROFILE_LOCATION_MAX_LENGTH,
  PROFILE_PHOTO_QUALITY,
  PROFILE_UNCROPPED_COVER_QUALITY,
  PROFILE_USERNAME_MAX_LENGTH,
  PROFILE_WEBSITE_MAX_LENGTH,
  type EditProfileField,
  type EditProfileFieldErrors,
  type EditProfileFormValues,
  type UsernameAvailability,
  buildProfileUpdateBody,
  editProfileFormFromProfile,
  hasEditProfileChanges,
  isProfileFieldVerdict,
  normalizeUsername,
  normalizeUsernameInput,
  profilePhotoCropAspect,
  readLocalUsernameRejection,
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
import { hexWithAlpha } from '@/lib/eased-fade';
import { appTheme, mediaColors, themes } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import type { ProfileResponse } from '@/lib/types';
import { haptic } from '@/lib/haptics';
import { invalidateWelcomeCredits } from '@/lib/use-onboarding-destination';

/** Debounce before the availability round trip. The endpoint is rate limited. */
const USERNAME_CHECK_DELAY_MS = 400;

/** The web editor's labels (`CreatorProfileCard`), in the order the form reads. */
const SOCIAL_FIELDS = [
  { field: 'twitterHandle', label: 'X (Twitter) handle' },
  { field: 'instagramHandle', label: 'Instagram handle' },
  { field: 'tiktokHandle', label: 'TikTok handle' },
] as const;

export function EditProfileScreen() {
  const theme = useAppTheme();
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

  const [form, setForm] = useState<EditProfileFormValues>(EMPTY_EDIT_PROFILE_FORM);
  // What the form opened as: the measure of unsaved changes and of what a save sends.
  const [initialForm, setInitialForm] = useState<EditProfileFormValues | null>(null);
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
  const websiteRef = useRef<TextInput | null>(null);
  const locationRef = useRef<TextInput | null>(null);
  const twitterRef = useRef<TextInput | null>(null);
  const instagramRef = useRef<TextInput | null>(null);
  const tiktokRef = useRef<TextInput | null>(null);
  const socialRefs = { twitterHandle: twitterRef, instagramHandle: instagramRef, tiktokHandle: tiktokRef };

  const profileQuery = useQuery({
    queryKey: ['profile', user?.id],
    enabled: Boolean(user),
    queryFn: api.getProfile,
  });

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

  const hasProfileChanges = hasEditProfileChanges({
    current: form,
    initial: initialForm ?? EMPTY_EDIT_PROFILE_FORM,
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
    // The placeholder and the reserved list are answered here, before any
    // round trip, in the words the server would use (D3).
    const localRejection = readLocalUsernameRejection(form.username, profile?.username);
    if (localRejection) {
      setUsernameAvailability('taken');
      setUsernameMessage(localRejection);
      return;
    }
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
      // A handle plus a display name completes the creator identity, which
      // the Home card reads through the welcome-credit query. Left alone, that
      // card kept prompting "Finish your creator setup" after this save.
      await invalidateWelcomeCredits(queryClient);
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
   * The form opens from the first profile read of this visit. A later read
   * replaces it only while nothing is edited and nothing is saving. The profile
   * is read again on every auth event, on a return to the app and when a run
   * finishes, and each read used to rebuild the form, taking typed text and a
   * picked photo with it. A picked photo is itself a change, so it is never
   * cleared here.
   */
  useEffect(() => {
    if (!profile) return;
    if (initialForm && (hasProfileChanges || isSaving)) return;
    const next = editProfileFormFromProfile(profile);
    if (initialForm && !hasEditProfileChanges({
      current: next,
      initial: initialForm,
      hasAvatarDraft: false,
      hasCoverDraft: false,
    })) return;
    setInitialForm(next);
    setForm(next);
    // Errors described values that are no longer in the form.
    setFieldErrors({});
    setMessage(null);
  }, [hasProfileChanges, initialForm, isSaving, profile]);

  /**
   * Modality: "if closing a modal could result in loss of user-generated
   * content, present an alert" — and this route is `presentation: 'modal'`, so
   * the swipe-down discards the form too. One guard covers the Close control,
   * the dismiss gesture and Android's hardware back; the composer's leave sheet
   * is the same shape, minus the draft this screen has nowhere to keep.
   */
  usePreventRemove(hasProfileChanges && !isLeaveAllowed && !isSaving, ({ data }) => {
    // A confirmation, not the app's action sheet, for two reasons that agree.
    // Alerts is what one destructive confirmation is for — `lib/action-sheet.ts`
    // says so itself, and the composer's sheet is a sheet because it has a
    // second choice (save the draft) that this screen has nowhere to keep. And
    // the sheet could not appear here anyway: `ActionSheetHost` is an in-window
    // overlay by design (an RN Modal cannot report keyboard height on Android),
    // and this route is `presentation: 'modal'` — a native modal presented
    // above that window. Captured on the simulator: the screen was correctly
    // held, and the sheet was nowhere, which traps a person on the form.
    //
    // "Keep editing" rather than "Cancel": the control they just pressed is
    // named Cancel, so a Cancel that means *stay* reverses itself (ledger DV8).
    // No message under the question — the title and the two labels already say
    // the whole thing, and Alerts asks for "a brief title and, optionally, a
    // short message", not a restatement.
    void showConfirmDialog({
      title: 'Discard your changes?',
      cancelLabel: 'Keep editing',
      confirmLabel: 'Discard',
      destructive: true,
    }).then((discard) => {
      if (!discard) return;
      setIsLeaveAllowed(true);
      // The guard is still armed on this commit; dispatching on the next tick
      // lets `isLeaveAllowed` land first so the pop is not intercepted again.
      setTimeout(() => navigation.dispatch(data.action), 0);
    });
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

    const aspect = profilePhotoCropAspect(role, Platform.OS);
    const result = await ImagePicker.launchImageLibraryAsync(aspect
      ? { mediaTypes: ['images'], allowsEditing: true, aspect, quality: PROFILE_PHOTO_QUALITY }
      : {
          mediaTypes: ['images'],
          allowsEditing: false,
          // Taken whole, a library photo comes back as its own file, HEIC
          // included, which most browsers cannot draw. The compatible
          // representation is a JPEG.
          preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
          quality: PROFILE_UNCROPPED_COVER_QUALITY,
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
    if (!profile || !initialForm) {
      throw new Error('Load your profile before saving changes.');
    }

    const validationErrors = validateProfileForm(form, { savedUsername: profile.username });
    setFieldErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) {
      throw new Error('Fix the highlighted profile fields.');
    }

    if (avatarAsset || coverAsset) {
      // The links follow the server's rules (D4), so the server is asked before
      // anything uploads. A refused field is drawn and nothing is spent; a
      // request that fails without a verdict leaves the save to report.
      setProgressMessage('Checking your changes…');
      try {
        await api.validateProfile(buildProfileUpdateBody({ current: form, initial: initialForm }));
      } catch (error) {
        if (isProfileFieldVerdict(error)) throw error;
      }
    }

    let avatarUrl: string | null = null;
    let coverUrl: string | null = null;

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
    await api.updateProfile(buildProfileUpdateBody({ current: form, initial: initialForm, avatarUrl, coverUrl }));
  }

  function editField(field: EditProfileField, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
  }

  /**
   * Text fields: "when creating a user name or password, validation needs to
   * happen before people switch to another field."
   */
  function validateOnBlur(field: EditProfileField) {
    setFieldErrors((current) => ({
      ...current,
      [field]: validateProfileField(field, form[field], { savedUsername: profile?.username }),
    }));
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
        {/* Signing in comes back to this form, not Home (audit 01-12). */}
        <PrimaryButton
          label="Sign in"
          accent="primary"
          onPress={() => router.replace({ pathname: '/auth', params: { returnTo: '/edit-profile' } } as never)}
        />
      </EditProfileShell>
    );
  }

  const username = usernameHint({ availability: usernameAvailability, message: usernameMessage });

  return (
    <EditProfileShell header={header} scrollBottomPadding={scrollBottomPadding} horizontalPadding={horizontalPadding}>
      {profileQuery.isLoading ? (
        <View style={{ minHeight: 360, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={theme.colors.primary} />
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
                borderColor: fieldErrors.coverUrl ? theme.colors.danger : theme.colors.border,
                backgroundColor: theme.colors.panel,
                opacity: pressed ? appTheme.opacity.pressed : 1,
              })}
            >
              {coverDraftUri || form.coverUrl ? (
                <Image source={{ uri: coverDraftUri ?? form.coverUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
              ) : (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: theme.colors.panelSoft }}>
                  <ImageIcon size={appTheme.icon.hero} color={theme.colors.muted} />
                  <AppText variant="label" color="muted">Add a cover image</AppText>
                </View>
              )}
              <LinearGradient colors={[hexWithAlpha(mediaColors.mediaGround, 0.08), hexWithAlpha(mediaColors.mediaGround, 0.76)]} style={{ position: 'absolute', inset: 0 }} />
              <View style={{ position: 'absolute', right: 14, bottom: 14 }}>
                <ActionPill icon={<ImageIcon size={appTheme.icon.sm} color={themes.dark.colors.text} />} label="Change cover" />
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
                  borderColor: theme.colors.primary,
                  backgroundColor: theme.colors.background,
                  opacity: pressed ? appTheme.opacity.pressed : 1,
                })}
              >
                  <View style={{ flex: 1, overflow: 'hidden', borderRadius: 38, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.panelSoft }}>
                    {avatarDraftUri || form.avatarUrl ? (
                      <Image source={{ uri: avatarDraftUri ?? form.avatarUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
                    ) : (
                      <AppText variant="sectionTitle">{preview.initials}</AppText>
                    )}
                  </View>
                <View style={{ position: 'absolute', right: -2, bottom: 0, width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.primaryFill, borderWidth: 3, borderColor: theme.colors.background }}>
                  <Camera size={appTheme.icon.sm} color={theme.colors.onPrimary} />
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

          {/*
            The web editor's "Links and location" group. The app could not edit
            these five and sent back the copy it held, so a link changed on the
            web was undone by an unrelated save here.
          */}
          <View style={{ gap: appTheme.spacing.compact }}>
            <AppText heading variant="cardTitle">Links and location</AppText>
            <AppText variant="bodySm" color="muted">Website and social handles</AppText>
          </View>
          <GlassForm>
            <AppTextInput
              label="Website"
              value={form.websiteUrl}
              onChangeText={(websiteUrl) => editField('websiteUrl', websiteUrl)}
              onBlur={() => validateOnBlur('websiteUrl')}
              onClear={() => editField('websiteUrl', '')}
              error={fieldErrors.websiteUrl}
              placeholder="https://your-site.com"
              maxLength={PROFILE_WEBSITE_MAX_LENGTH}
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              autoComplete="url"
              textContentType="URL"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => locationRef.current?.focus()}
              inputRef={websiteRef}
            />
            <AppTextInput
              label="Location"
              value={form.location}
              onChangeText={(location) => editField('location', location)}
              onBlur={() => validateOnBlur('location')}
              onClear={() => editField('location', '')}
              error={fieldErrors.location}
              placeholder="City, country"
              maxLength={PROFILE_LOCATION_MAX_LENGTH}
              autoCapitalize="words"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => socialRefs.twitterHandle.current?.focus()}
              inputRef={locationRef}
            />
            {SOCIAL_FIELDS.map(({ field, label }, index) => {
              const next = SOCIAL_FIELDS[index + 1];
              return (
                <AppTextInput
                  key={field}
                  label={label}
                  value={form[field]}
                  onChangeText={(value) => editField(field, value)}
                  onBlur={() => validateOnBlur(field)}
                  onClear={() => editField(field, '')}
                  error={fieldErrors[field]}
                  // A handle or the profile link, as the server takes either (D4).
                  hint="Username or profile link"
                  placeholder="username"
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  returnKeyType={next ? 'next' : 'done'}
                  submitBehavior={next ? 'submit' : 'blurAndSubmit'}
                  onSubmitEditing={next ? () => socialRefs[next.field].current?.focus() : undefined}
                  inputRef={socialRefs[field]}
                />
              );
            })}
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
  const theme = useAppTheme();
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
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
  const theme = useAppTheme();
  const disabled = !onSave || isSaving;

  return (
    <View
      style={{
        paddingTop: Math.max(8, topInset),
        paddingHorizontal: 14,
        paddingBottom: 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.background,
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
            backgroundColor: pressed ? theme.colors.surfaceStrong : 'transparent',
            opacity: isSaving ? appTheme.opacity.disabled : 1,
          })}
        >
          <CloseGlyph size={appTheme.icon.feature} color={theme.colors.text} />
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
              ? theme.colors.panelSoft
              : pressed ? theme.colors.primaryFillPressed : theme.colors.primaryFill,
            opacity: disabled ? appTheme.opacity.disabled : 1,
          })}
        >
          {/*
            Buttons: "you can also configure the button to display a different
            label alongside the activity indicator ... 'Checkout' could change to
            'Checking out…'". It used to spin beside a label still reading Save.
          */}
          {isSaving
            ? <ActivityIndicator color={theme.colors.onPrimary} size="small" />
            : <Check size={appTheme.icon.sm} color={disabled ? theme.colors.text : theme.colors.onPrimary} />}
          <AppText variant="button" color={disabled ? 'text' : theme.colors.onPrimary}>
            {isSaving ? 'Saving…' : 'Save'}
          </AppText>
        </Pressable>
      </View>
    </View>
  );
}

function GlassForm({ children }: { children: React.ReactNode }) {
  const theme = useAppTheme();
  return (
    <View
      style={{
        gap: 16,
        borderRadius: appTheme.radii.xl,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.panel,
        padding: 16,
      }}
    >
      {children}
    </View>
  );
}

/** Drawn on the cover photo, under its dark shade, so dark in both schemes. */
function ActionPill({ icon, label }: { icon: React.ReactNode; label: string }) {
  const onPhoto = themes.dark.colors;
  return (
    <View style={{ minHeight: appTheme.touch.default, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: appTheme.radii.pill, backgroundColor: onPhoto.overlayStrong, paddingHorizontal: 14, paddingVertical: 9 }}>
      {icon}
      <AppText variant="label" color={onPhoto.text}>{label}</AppText>
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
