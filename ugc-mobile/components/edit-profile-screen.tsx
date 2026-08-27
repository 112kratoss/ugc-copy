import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { Camera, Check, ImageIcon } from 'lucide-react-native';
import type { ComponentProps } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { KeyboardAvoidingArea } from '@/components/keyboard-aware';
import { PrimaryButton, SecondaryButton, StatusBlock } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { hasEditProfileChanges } from '@/lib/edit-profile-form';
import { getEditProfileScrollPadding } from '@/lib/edit-profile-layout';
import { uploadProfileImage } from '@/lib/media';
import { getProfileHandle, getProfileInitials, getProfileName } from '@/lib/profile-view-model';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { CloseGlyph } from '@/lib/platform-glyphs';
import { appTheme } from '@/lib/theme';
import type { ProfileResponse } from '@/lib/types';

const USERNAME_PATTERN = /^[a-z0-9-]{3,24}$/;
const MAX_DISPLAY_NAME_LENGTH = 60;
const MAX_BIO_LENGTH = 280;

interface EditProfileForm {
  username: string;
  displayName: string;
  bio: string;
  avatarUrl: string;
  coverUrl: string;
}

type FieldErrors = Partial<Record<keyof EditProfileForm, string>>;

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
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
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
      setProgressMessage(null);
    }
  }, [profileQuery.data]);

  const profile = profileQuery.data;
  const previewName = getProfileName(
    {
      ...(profile ?? emptyProfile(user?.id ?? 'preview')),
      username: normalizeUsername(form.username) || profile?.username || profile?.suggestedUsername || null,
      displayName: form.displayName || null,
      bio: form.bio || null,
      avatarUrl: (avatarDraftUri ?? form.avatarUrl) || null,
      coverUrl: (coverDraftUri ?? form.coverUrl) || null,
    },
    user?.email
  );
  const previewHandle = getProfileHandle(
    {
      ...(profile ?? emptyProfile(user?.id ?? 'preview')),
      username: normalizeUsername(form.username) || profile?.username || profile?.suggestedUsername || null,
      displayName: form.displayName || null,
    },
    user?.email
  );
  const previewInitials = getProfileInitials(
    {
      ...(profile ?? emptyProfile(user?.id ?? 'preview')),
      username: normalizeUsername(form.username) || profile?.username || profile?.suggestedUsername || null,
      displayName: form.displayName || null,
    },
    user?.email
  );
  const initialForm = useMemo(() => (profile ? formFromProfile(profile) : emptyForm), [profile]);
  const hasProfileChanges = hasEditProfileChanges({
    current: form,
    initial: initialForm,
    hasAvatarDraft: Boolean(avatarAsset),
    hasCoverDraft: Boolean(coverAsset),
  });
  const bioCount = form.bio.length;
  const saveMutation = useMutation({
    mutationFn: saveProfile,
    onMutate: () => {
      setMessage(null);
      setProgressMessage('Preparing your changes...');
    },
    onSuccess: async () => {
      await refreshProfile();
      await queryClient.invalidateQueries({ queryKey: ['profile'] });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (router.canGoBack()) {
        router.back();
      } else {
        router.replace('/(tabs)/profile' as never);
      }
    },
    onError: async (error) => {
      setProgressMessage(null);
      if (error instanceof ApiError) {
        const details = error.details as { fieldErrors?: FieldErrors } | undefined;
        if (details?.fieldErrors) {
          setFieldErrors((current) => ({ ...current, ...details.fieldErrors }));
        }
      }
      setMessage(error instanceof Error ? error.message : 'Profile could not be saved.');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    },
    onSettled: () => {
      setProgressMessage(null);
    },
  });

  async function pickProfileImage(role: 'avatar' | 'cover') {
    setMessage(null);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setMessage('Allow photo access to choose a profile image.');
      return;
    }

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

    const validationErrors = validateForm(form);
    setFieldErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) {
      throw new Error('Fix the highlighted profile fields.');
    }

    let avatarUrl = form.avatarUrl || null;
    let coverUrl = form.coverUrl || null;

    if (avatarAsset) {
      setProgressMessage('Uploading display photo...');
      avatarUrl = await uploadProfileImage(avatarAsset.uri, {
        api,
        role: 'avatar',
        fileName: avatarAsset.fileName,
        mimeType: avatarAsset.mimeType,
        sizeBytes: avatarAsset.fileSize,
      });
    }

    if (coverAsset) {
      setProgressMessage('Uploading background picture...');
      coverUrl = await uploadProfileImage(coverAsset.uri, {
        api,
        role: 'cover',
        fileName: coverAsset.fileName,
        mimeType: coverAsset.mimeType,
        sizeBytes: coverAsset.fileSize,
      });
    }

    setProgressMessage('Saving profile...');
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

  if (!user) {
    return (
      <EditProfileShell topInset={topInset} scrollBottomPadding={scrollBottomPadding} horizontalPadding={horizontalPadding}>
        <EditHeader isSaving={false} onBack={leaveEditProfile} onSave={undefined} />
        <StatusBlock title="Sign in required" body="Sign in to update your Magicbooklet profile." />
        <PrimaryButton label="Sign in" accent="primary" onPress={() => router.replace('/auth' as never)} />
      </EditProfileShell>
    );
  }

  return (
    <EditProfileShell topInset={topInset} scrollBottomPadding={scrollBottomPadding} horizontalPadding={horizontalPadding}>
      <EditHeader
        isSaving={saveMutation.isPending}
        onBack={leaveEditProfile}
        onSave={hasProfileChanges && profileQuery.isSuccess && Boolean(profile) ? () => saveMutation.mutate() : undefined}
      />

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
                opacity: pressed ? 0.86 : 1,
              })}
            >
              {coverDraftUri || form.coverUrl ? (
                <Image source={{ uri: coverDraftUri ?? form.coverUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
              ) : (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: appTheme.colors.panelSoft }}>
                  <ImageIcon size={26} color={appTheme.colors.muted} />
                  <Text style={{ color: appTheme.colors.muted, fontSize: 13, fontWeight: '600' }}>Add a cover image</Text>
                </View>
              )}
              <LinearGradient colors={['rgba(3,4,13,0.08)', 'rgba(3,4,13,0.76)']} style={{ position: 'absolute', inset: 0 }} />
              <View style={{ position: 'absolute', left: 18, right: 18, bottom: 18, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 14 }}>
                <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                  <Text numberOfLines={1} style={{ color: appTheme.colors.text, fontSize: 22, fontWeight: '700' }}>{previewName}</Text>
                  <Text style={{ color: appTheme.colors.primary, fontSize: 14, fontWeight: '700' }}>{previewHandle}</Text>
                </View>
                <ActionPill icon={<ImageIcon size={17} color={appTheme.colors.text} />} label="Change cover" />
              </View>
            </Pressable>

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
                  opacity: pressed ? 0.86 : 1,
                })}
              >
                  <View style={{ flex: 1, overflow: 'hidden', borderRadius: 38, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.panelSoft }}>
                    {avatarDraftUri || form.avatarUrl ? (
                      <Image source={{ uri: avatarDraftUri ?? form.avatarUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
                    ) : (
                      <Text style={{ color: appTheme.colors.text, fontSize: 24, fontWeight: '700' }}>{previewInitials}</Text>
                    )}
                  </View>
                <View style={{ position: 'absolute', right: -2, bottom: 0, width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.primary, borderWidth: 3, borderColor: appTheme.colors.background }}>
                  <Camera size={16} color={appTheme.colors.onPrimary} />
                </View>
              </Pressable>
              <Text style={{ color: appTheme.colors.muted, fontSize: 13, fontWeight: '600', paddingBottom: 12 }}>Tap photo to replace</Text>
            </View>
            {fieldErrors.avatarUrl || fieldErrors.coverUrl ? (
              <View style={{ paddingHorizontal: 4, paddingTop: 10, gap: 4 }}>
                {fieldErrors.avatarUrl ? <ErrorText text={fieldErrors.avatarUrl} /> : null}
                {fieldErrors.coverUrl ? <ErrorText text={fieldErrors.coverUrl} /> : null}
              </View>
            ) : null}
          </View>

          <GlassForm>
            <ProfileTextField
              label="Display name"
              value={form.displayName}
              onChangeText={(displayName) => {
                setForm((current) => ({ ...current, displayName }));
                setFieldErrors((current) => ({ ...current, displayName: undefined }));
              }}
              error={fieldErrors.displayName}
              placeholder="LunaDreams"
              maxLength={MAX_DISPLAY_NAME_LENGTH}
              autoCapitalize="words"
              textContentType="name"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => usernameRef.current?.focus()}
            />
            <ProfileTextField
              label="Username"
              value={form.username}
              onChangeText={(username) => {
                setForm((current) => ({ ...current, username }));
                setFieldErrors((current) => ({ ...current, username: undefined }));
              }}
              error={fieldErrors.username}
              placeholder="@lunadreams"
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              textContentType="nickname"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => bioRef.current?.focus()}
              inputRef={usernameRef}
            />
            <ProfileTextField
              label="Bio"
              value={form.bio}
              onChangeText={(bio) => {
                setForm((current) => ({ ...current, bio }));
                setFieldErrors((current) => ({ ...current, bio: undefined }));
              }}
              error={fieldErrors.bio}
              placeholder="Fantasy worlds, motion stories, and AI art experiments."
              multiline
              maxLength={MAX_BIO_LENGTH}
              footer={`${bioCount}/${MAX_BIO_LENGTH}`}
              inputRef={bioRef}
            />
          </GlassForm>

          <SecondaryButton label="Cancel" disabled={saveMutation.isPending} onPress={leaveEditProfile} />
        </>
      )}
    </EditProfileShell>
  );

  function leaveEditProfile() {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)/profile' as never);
    }
  }
}

function EditProfileShell({
  children,
  topInset,
  scrollBottomPadding,
  horizontalPadding,
}: {
  children: React.ReactNode;
  topInset: number;
  scrollBottomPadding: number;
  horizontalPadding: number;
}) {
  return (
    <View style={{ flex: 1, backgroundColor: appTheme.colors.background, paddingTop: topInset }}>
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

function EditHeader({
  isSaving,
  onBack,
  onSave,
}: {
  isSaving: boolean;
  onBack: () => void;
  onSave?: () => void;
}) {
  return (
    <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel"
        disabled={isSaving}
        onPress={onBack}
        style={({ pressed }) => ({
          width: 48,
          height: 48,
          borderRadius: 24,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: appTheme.colors.panelSoft,
          opacity: pressed ? 0.72 : isSaving ? 0.5 : 1,
        })}
      >
        <CloseGlyph size={appTheme.icon.feature} color={appTheme.colors.text} />
      </Pressable>
      <Text accessibilityRole="header" style={{ flex: 1, textAlign: 'center', color: appTheme.colors.text, fontSize: 21, fontWeight: '700' }}>Edit Profile</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save profile"
        disabled={!onSave || isSaving}
        onPress={onSave}
        style={({ pressed }) => ({
          minWidth: 82,
          minHeight: 48,
          borderRadius: 24,
          paddingHorizontal: 14,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 7,
          backgroundColor: !onSave || isSaving ? appTheme.colors.panelSoft : pressed ? appTheme.colors.primaryStrong : appTheme.colors.primary,
          opacity: !onSave || isSaving ? appTheme.opacity.disabled : 1,
        })}
      >
        {isSaving ? <ActivityIndicator color={appTheme.colors.onPrimary} size="small" /> : <Check size={16} color={onSave ? appTheme.colors.onPrimary : appTheme.colors.faint} />}
        <Text style={{ color: onSave ? appTheme.colors.onPrimary : appTheme.colors.faint, fontSize: 14, fontWeight: '700' }}>Save</Text>
      </Pressable>
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

function ProfileTextField({
  label,
  error,
  footer,
  multiline,
  inputRef,
  ...props
}: ComponentProps<typeof TextInput> & {
  label: string;
  error?: string;
  footer?: string;
  inputRef?: React.RefObject<TextInput | null>;
}) {
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <Text style={{ color: appTheme.colors.textSecondary, fontSize: 12, fontWeight: '700' }}>{label}</Text>
        {footer ? <Text style={{ color: appTheme.colors.faint, fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] }}>{footer}</Text> : null}
      </View>
      <TextInput
        ref={inputRef}
        accessibilityLabel={label}
        aria-invalid={Boolean(error)}
        placeholderTextColor={appTheme.colors.faint}
        multiline={multiline}
        textAlignVertical={multiline ? 'top' : 'center'}
        style={{
          minHeight: multiline ? 112 : appTheme.touch.roomy,
          borderRadius: multiline ? 22 : 18,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: error ? appTheme.colors.danger : appTheme.colors.border,
          backgroundColor: appTheme.colors.surfaceInset,
          color: appTheme.colors.text,
          fontSize: 16,
          fontWeight: '500',
          paddingHorizontal: 15,
          paddingVertical: multiline ? 14 : 0,
        }}
        {...props}
      />
      {error ? <ErrorText text={error} /> : null}
    </View>
  );
}

function ActionPill({
  icon,
  label,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  onPress?: () => void;
}) {
  const content = (
    <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 24, backgroundColor: appTheme.colors.overlayStrong, paddingHorizontal: 14, paddingVertical: 9 }}>
      {icon}
      <Text style={{ color: appTheme.colors.text, fontSize: 13, fontWeight: '700' }}>{label}</Text>
    </View>
  );

  if (!onPress) return content;

  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.76 : 1 })}>
      {content}
    </Pressable>
  );
}

function ErrorText({ text }: { text: string }) {
  return <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: appTheme.colors.danger, fontSize: 13, lineHeight: 18, fontWeight: '600' }}>{text}</Text>;
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

function normalizeUsername(value: string) {
  const normalized = value.trim().replace(/^@+/, '').toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function validateForm(form: EditProfileForm): FieldErrors {
  const errors: FieldErrors = {};
  const username = normalizeUsername(form.username);

  if (!username) {
    errors.username = 'Choose a username for your profile.';
  } else if (!USERNAME_PATTERN.test(username)) {
    errors.username = 'Use 3-24 lowercase letters, numbers, or hyphens.';
  }

  if (form.displayName.trim().length > MAX_DISPLAY_NAME_LENGTH) {
    errors.displayName = `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`;
  }

  if (form.bio.trim().length > MAX_BIO_LENGTH) {
    errors.bio = `Bio must be ${MAX_BIO_LENGTH} characters or fewer.`;
  }

  return errors;
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
