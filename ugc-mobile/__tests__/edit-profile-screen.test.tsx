// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProfileResponse } from '../lib/types';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

const harness = vi.hoisted(() => ({
  user: { id: 'user-1', email: 'luna@example.com' } as { id: string; email: string } | null,
  api: {
    getProfile: vi.fn(),
    validateProfile: vi.fn(),
    updateProfile: vi.fn(),
  },
  refreshProfile: vi.fn(async () => undefined),
  router: { back: vi.fn(), replace: vi.fn(), canGoBack: vi.fn(() => true) },
  navigation: { dispatch: vi.fn() },
  picker: {
    requestMediaLibraryPermissionsAsync: vi.fn(),
    launchImageLibraryAsync: vi.fn(),
  },
  uploadProfileImage: vi.fn(),
  scrollView: { scrollTo: vi.fn() },
  scrollContent: { name: 'scroll content' },
  /** Where each field sits in the scroll content, by label: what `measureLayout` answers. */
  fieldTops: {} as Record<string, number>,
  reducedMotion: false,
}));

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  Linking: { openSettings: vi.fn() },
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  Pressable: ({ children, style, ...props }: MockProps) => React.createElement(
    'pressable',
    { ...props, style: typeof style === 'function' ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false }) : style },
    children,
  ),
  ScrollView: ({ children, ref, innerViewRef, ...props }: MockProps) => {
    React.useImperativeHandle(ref as React.Ref<unknown>, () => harness.scrollView);
    React.useImperativeHandle(innerViewRef as React.Ref<unknown>, () => harness.scrollContent);
    return React.createElement('scroll-view', props, children);
  },
  TextInput: () => null,
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
}));

vi.mock('@react-navigation/native', () => ({
  useNavigation: () => harness.navigation,
  usePreventRemove: vi.fn(),
}));

vi.mock('expo-router', () => ({ router: harness.router }));

vi.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: (...args: unknown[]) => harness.picker.requestMediaLibraryPermissionsAsync(...args),
  launchImageLibraryAsync: (...args: unknown[]) => harness.picker.launchImageLibraryAsync(...args),
  UIImagePickerPreferredAssetRepresentationMode: { Automatic: 'automatic', Compatible: 'compatible', Current: 'current' },
}));

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children, ...props }: MockProps) => React.createElement('linear-gradient', props, children),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

vi.mock('lucide-react-native', () => {
  const icon = (name: string) => (props: Record<string, unknown>) => React.createElement('icon', { name, ...props });
  return { Camera: icon('Camera'), Check: icon('Check'), ImageIcon: icon('ImageIcon') };
});

vi.mock('@/components/keyboard-aware', () => ({
  KeyboardAvoidingArea: ({ children, ...props }: MockProps) => React.createElement('keyboard-area', props, children),
}));

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('app-text', props, children),
  AppTextInput: ({ containerRef, ...props }: MockProps) => {
    // Measured against the scroll content, a field answers where `fieldTops` puts it.
    React.useImperativeHandle(containerRef as React.Ref<unknown>, () => ({
      measureLayout: (relativeTo: unknown, onSuccess: (x: number, y: number, width: number, height: number) => void) => {
        onSuccess(0, relativeTo === harness.scrollContent ? harness.fieldTops[String(props.label)] ?? 0 : Number.NaN, 358, 96);
      },
    }));
    return React.createElement('app-text-input', props);
  },
  PrimaryButton: (props: MockProps) => React.createElement('primary-button', props),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
  StatusBlock: (props: MockProps) => React.createElement('status-block', props),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => harness,
}));

vi.mock('@/lib/dialog', () => ({ showConfirmDialog: vi.fn(async () => false) }));
vi.mock('@/lib/haptics', () => ({ haptic: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/media', () => ({
  uploadProfileImage: (...args: unknown[]) => harness.uploadProfileImage(...args),
}));
vi.mock('@/lib/motion', () => ({ useReducedMotion: () => harness.reducedMotion }));
vi.mock('@/lib/platform-glyphs', () => ({
  CloseGlyph: (props: MockProps) => React.createElement('close-glyph', props),
}));
vi.mock('@/lib/safe-area', () => ({
  resolvedTopInset: (value: number) => value,
  resolvedBottomInset: (value: number) => value,
}));
vi.mock('@/lib/use-onboarding-destination', () => ({ invalidateWelcomeCredits: vi.fn(async () => undefined) }));

import { EditProfileScreen } from '../components/edit-profile-screen';
import { ApiError } from '../lib/api-client';
import { HANDLE_CHECK_DELAY_MS } from '../lib/use-handle-availability';

const PROFILE_KEY = ['profile', 'user-1'];

function storedProfile(overrides: Partial<ProfileResponse> = {}): ProfileResponse {
  return {
    id: 'user-1',
    username: 'luna-dreams',
    suggestedUsername: 'creator-1a2b3c4d',
    displayName: 'Luna',
    bio: 'Old bio',
    avatarUrl: 'https://cdn.example/avatar.webp',
    coverUrl: 'https://cdn.example/cover.webp',
    websiteUrl: 'https://luna.example',
    twitterHandle: 'luna',
    instagramHandle: null,
    tiktokHandle: null,
    location: 'Lisbon',
    credits: 40,
    stats: { creations: 12, posts: 3, archivedPosts: 0, saved: 5 },
    ...overrides,
  };
}

function newClient(profile: ProfileResponse) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(PROFILE_KEY, profile);
  return client;
}

/** React Query hands an update to its observers on a timer; give it a few. */
const flush = () => renderer.act(async () => {
  for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
});

async function renderScreen(client: QueryClient, element: React.ReactElement = <EditProfileScreen />) {
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tree = renderer.create(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  });
  await flush();
  return tree;
}

function input(tree: renderer.ReactTestRenderer, label: string) {
  return tree.root.find((node) => String(node.type) === 'app-text-input' && node.props.label === label);
}

async function type(tree: renderer.ReactTestRenderer, label: string, value: string) {
  await renderer.act(async () => { input(tree, label).props.onChangeText(value); });
}

function pressable(tree: renderer.ReactTestRenderer, accessibilityLabel: string) {
  return tree.root.find((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === accessibilityLabel);
}

async function press(tree: renderer.ReactTestRenderer, accessibilityLabel: string) {
  await renderer.act(async () => { pressable(tree, accessibilityLabel).props.onPress(); });
  await flush();
}

/** Under fake timers: lets the handle check's pause run out and its answer arrive. */
async function letTheCheckAnswer() {
  await renderer.act(async () => {
    vi.advanceTimersByTime(HANDLE_CHECK_DELAY_MS);
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
  });
}

function images(tree: renderer.ReactTestRenderer) {
  return tree.root
    .findAll((node) => typeof node.props.source === 'object' && node.props.source !== null && 'uri' in node.props.source)
    .map((node) => (node.props.source as { uri: string }).uri);
}

function statusBlocks(tree: renderer.ReactTestRenderer) {
  return tree.root
    .findAll((node) => String(node.type) === 'status-block')
    .map((node) => ({ title: node.props.title as string, body: node.props.body as string | undefined }));
}

/** The server's answer to a save whose handle was claimed after the live check called it free. */
function takenAtSave() {
  return new ApiError('That username is already taken.', 409, {
    error: 'That username is already taken.',
    fieldErrors: { username: 'That username is already taken.' },
  });
}

/** Types a handle and lets the live check answer it, with fake timers for the check's pause alone. */
async function typeHandleAndLetTheCheckAnswer(tree: renderer.ReactTestRenderer, handle: string) {
  vi.useFakeTimers();
  try {
    await type(tree, 'Username', handle);
    await letTheCheckAnswer();
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  // The save's own refresh reads the profile again.
  harness.api.getProfile.mockReset().mockImplementation(async () => storedProfile());
  harness.api.validateProfile.mockReset().mockResolvedValue({ ok: true });
  harness.api.updateProfile.mockReset().mockImplementation(async (body: Record<string, unknown>) => body);
  harness.uploadProfileImage.mockReset().mockImplementation(async (_uri: string, options: { role: string }) => `https://cdn.example/${options.role}-new.jpg`);
  harness.picker.requestMediaLibraryPermissionsAsync.mockReset().mockResolvedValue({ granted: true });
  harness.picker.launchImageLibraryAsync.mockReset().mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file:///picked.jpg', fileName: 'picked.jpg', mimeType: 'image/jpeg', fileSize: 1024 }],
  });
  harness.router.back.mockClear();
  harness.router.replace.mockClear();
  harness.user = { id: 'user-1', email: 'luna@example.com' };
  harness.scrollView.scrollTo.mockClear();
  harness.fieldTops = {};
  harness.reducedMotion = false;
});

describe('Edit profile: links and location', () => {
  it('opens with the links and location the profile holds', async () => {
    const tree = await renderScreen(newClient(storedProfile()));

    expect(input(tree, 'Website').props.value).toBe('https://luna.example');
    expect(input(tree, 'Location').props.value).toBe('Lisbon');
    expect(input(tree, 'X (Twitter) handle').props.value).toBe('luna');
    expect(input(tree, 'Instagram handle').props.value).toBe('');
    expect(input(tree, 'TikTok handle').props).toMatchObject({ value: '', hint: 'Username or profile link' });
  });

  it('saves an edited link alone, beside the handle every save carries', async () => {
    const tree = await renderScreen(newClient(storedProfile()));

    await type(tree, 'Instagram handle', 'https://instagram.com/luna.dreams');
    await press(tree, 'Save profile');

    expect(harness.api.updateProfile).toHaveBeenCalledTimes(1);
    expect(harness.api.updateProfile).toHaveBeenCalledWith({
      username: 'luna-dreams',
      instagramHandle: 'https://instagram.com/luna.dreams',
    });
    expect(harness.router.back).toHaveBeenCalledTimes(1);
  });

  it('draws the server’s refusal of a social link under its field, and brings the field into view', async () => {
    harness.api.updateProfile.mockRejectedValue(new ApiError('Please fix the highlighted fields.', 400, {
      fieldErrors: { twitterHandle: 'Enter your X username or profile link.' },
    }));
    harness.fieldTops = { 'X (Twitter) handle': 1012 };
    const tree = await renderScreen(newClient(storedProfile()));

    await type(tree, 'X (Twitter) handle', 'https://example.com/luna');
    await press(tree, 'Save profile');

    expect(input(tree, 'X (Twitter) handle').props.error).toBe('Enter your X username or profile link.');
    // Said under the field alone: the block above the form would say it again,
    // and go on saying it once the link was fixed.
    expect(statusBlocks(tree)).toEqual([]);
    expect(harness.scrollView.scrollTo).toHaveBeenLastCalledWith({ y: 996, animated: true });
  });

  it('asks the server about the fields before a photo uploads, and uploads nothing it refuses', async () => {
    harness.api.validateProfile.mockRejectedValue(new ApiError('Please fix the highlighted fields.', 400, {
      fieldErrors: { tiktokHandle: 'Enter your TikTok username or profile link.' },
    }));
    const tree = await renderScreen(newClient(storedProfile()));

    await press(tree, 'Change display photo');
    await type(tree, 'TikTok handle', 'x');
    await press(tree, 'Save profile');

    expect(harness.api.validateProfile).toHaveBeenCalledWith({ username: 'luna-dreams', tiktokHandle: 'x' });
    expect(harness.uploadProfileImage).not.toHaveBeenCalled();
    expect(harness.api.updateProfile).not.toHaveBeenCalled();
    expect(input(tree, 'TikTok handle').props.error).toBe('Enter your TikTok username or profile link.');
  });

  it('uploads and saves when the check fails without a verdict', async () => {
    harness.api.validateProfile.mockRejectedValue(new ApiError('Too many requests', 429));
    const tree = await renderScreen(newClient(storedProfile()));

    await press(tree, 'Change display photo');
    await press(tree, 'Save profile');

    expect(harness.uploadProfileImage).toHaveBeenCalledTimes(1);
    expect(harness.api.updateProfile).toHaveBeenCalledWith({
      username: 'luna-dreams',
      avatarUrl: 'https://cdn.example/avatar-new.jpg',
    });
  });
});

describe('Edit profile: a profile read again while the form is open', () => {
  it('keeps typed text and a picked photo when the profile is read again', async () => {
    const client = newClient(storedProfile());
    const tree = await renderScreen(client);

    await type(tree, 'Bio', 'New bio');
    await press(tree, 'Change cover');
    expect(images(tree)).toContain('file:///picked.jpg');

    // A finished run moves a count, and the web changed the website meanwhile.
    await renderer.act(async () => {
      client.setQueryData(PROFILE_KEY, storedProfile({
        websiteUrl: 'https://changed-on-web.example',
        stats: { creations: 13, posts: 3, archivedPosts: 0, saved: 5 },
      }));
    });
    await flush();

    expect(input(tree, 'Bio').props.value).toBe('New bio');
    expect(input(tree, 'Website').props.value).toBe('https://luna.example');
    expect(images(tree)).toContain('file:///picked.jpg');

    // The save sends what was edited, so the web's website stays as it is.
    await press(tree, 'Save profile');
    expect(harness.api.updateProfile).toHaveBeenCalledWith({
      username: 'luna-dreams',
      bio: 'New bio',
      coverUrl: 'https://cdn.example/cover-new.jpg',
    });
  });

  it('shows a fresh read while nothing has been edited', async () => {
    const client = newClient(storedProfile());
    const tree = await renderScreen(client);

    await renderer.act(async () => {
      client.setQueryData(PROFILE_KEY, storedProfile({ location: 'Porto' }));
    });
    await flush();

    expect(input(tree, 'Location').props.value).toBe('Porto');
    expect(pressable(tree, 'Save profile').props.disabled).toBe(true);
  });

  it('keeps typed text after every effect runs again', async () => {
    // Fast Refresh, or an <Activity> shown again, re-runs each effect over kept state.
    const client = newClient(storedProfile());
    const inActivity = (mode: 'visible' | 'hidden') => (
      <QueryClientProvider client={client}>
        <React.Activity mode={mode}><EditProfileScreen /></React.Activity>
      </QueryClientProvider>
    );
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => { tree = renderer.create(inActivity('visible')); });
    await flush();

    await type(tree, 'Bio', 'New bio');
    await renderer.act(async () => { tree.update(inActivity('hidden')); });
    await renderer.act(async () => { tree.update(inActivity('visible')); });
    await flush();

    expect(input(tree, 'Bio').props.value).toBe('New bio');
    expect(pressable(tree, 'Save profile').props.disabled).toBe(false);
  });
});

describe('Edit profile: handles', () => {
  it('opens an unclaimed account with an empty handle and asks for one before anything uploads', async () => {
    const tree = await renderScreen(newClient(storedProfile({ username: 'creator-1a2b3c4d' })));
    expect(input(tree, 'Username').props.value).toBe('');

    await press(tree, 'Change display photo');
    await type(tree, 'Bio', 'New bio');
    await press(tree, 'Save profile');

    expect(input(tree, 'Username').props.error).toBe('Choose a username for your profile.');
    expect(harness.api.validateProfile).not.toHaveBeenCalled();
    expect(harness.uploadProfileImage).not.toHaveBeenCalled();
    expect(harness.api.updateProfile).not.toHaveBeenCalled();
  });

  it('refuses a reserved handle as it is typed, with no request', async () => {
    const tree = await renderScreen(newClient(storedProfile()));

    await type(tree, 'Username', 'support');

    expect(input(tree, 'Username').props).toMatchObject({ hint: 'That handle is reserved.', hintTone: 'danger' });
    expect(pressable(tree, 'Save profile').props.disabled).toBe(true);
    expect(harness.api.validateProfile).not.toHaveBeenCalled();
  });

  it('keeps the answer for the handle in the field when one for an earlier handle comes back last', async () => {
    // `maya` is taken and slow to answer; `maya-k` is free and answered at once.
    let refuseMaya!: (error: unknown) => void;
    harness.api.validateProfile.mockImplementation(({ username }: { username: string }) => (
      username === 'maya'
        ? new Promise((_resolve, reject) => { refuseMaya = reject; })
        : Promise.resolve({ ok: true })
    ));
    const tree = await renderScreen(newClient(storedProfile()));
    vi.useFakeTimers();
    try {
      await type(tree, 'Username', 'maya');
      await letTheCheckAnswer();
      await type(tree, 'Username', 'maya-k');
      await letTheCheckAnswer();
      expect(input(tree, 'Username').props).toMatchObject({ hint: 'This username is available.', hintTone: 'success' });

      await renderer.act(async () => {
        refuseMaya(new ApiError('That username is already taken.', 409, {
          error: 'That username is already taken.',
          fieldErrors: { username: 'That username is already taken.' },
        }));
        for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
      });

      expect(input(tree, 'Username').props).toMatchObject({ hint: 'This username is available.', hintTone: 'success' });
      expect(pressable(tree, 'Save profile').props.disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not ask about the same handle again when only the name changes', async () => {
    const tree = await renderScreen(newClient(storedProfile()));
    vi.useFakeTimers();
    try {
      await type(tree, 'Username', 'maya-k');
      await letTheCheckAnswer();
      expect(harness.api.validateProfile).toHaveBeenCalledTimes(1);

      await type(tree, 'Display name', 'Maya K');
      await letTheCheckAnswer();

      expect(harness.api.validateProfile).toHaveBeenCalledTimes(1);
      expect(input(tree, 'Username').props).toMatchObject({ hint: 'This username is available.', hintTone: 'success' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Edit profile: a refused save', () => {
  it('stops calling a handle taken once another is typed after the save refused it', async () => {
    harness.api.updateProfile.mockRejectedValue(takenAtSave());
    const tree = await renderScreen(newClient(storedProfile()));

    await typeHandleAndLetTheCheckAnswer(tree, 'maya');
    await press(tree, 'Save profile');
    expect(input(tree, 'Username').props.error).toBe('That username is already taken.');

    await typeHandleAndLetTheCheckAnswer(tree, 'maya-k');

    expect(input(tree, 'Username').props).toMatchObject({
      error: undefined,
      hint: 'This username is available.',
      hintTone: 'success',
    });
    // The block above the form kept "That username is already taken." until the next save.
    expect(statusBlocks(tree)).toEqual([]);
  });

  it('says a refusal of the handle under the handle alone, and brings the field into view', async () => {
    harness.api.updateProfile.mockRejectedValue(takenAtSave());
    harness.fieldTops = { Username: 412 };
    const tree = await renderScreen(newClient(storedProfile()));

    await typeHandleAndLetTheCheckAnswer(tree, 'maya');
    await press(tree, 'Save profile');

    expect(input(tree, 'Username').props.error).toBe('That username is already taken.');
    expect(statusBlocks(tree)).toEqual([]);
    // Save is in the header and the field can be anywhere: the field's top
    // comes to the form's own top padding, its verdict under it.
    expect(harness.scrollView.scrollTo).toHaveBeenCalledTimes(1);
    expect(harness.scrollView.scrollTo).toHaveBeenLastCalledWith({ y: 396, animated: true });
  });

  it('keeps the save’s refusal under the handle when the field is left without an edit', async () => {
    harness.api.updateProfile.mockRejectedValue(takenAtSave());
    const tree = await renderScreen(newClient(storedProfile()));

    await typeHandleAndLetTheCheckAnswer(tree, 'maya');
    await press(tree, 'Save profile');
    // Focus comes back to the field and moves on, as Next from Display name does.
    await renderer.act(async () => { input(tree, 'Username').props.onBlur(); });

    // The blur's own check finds nothing wrong with `maya` and used to clear the
    // refusal, which left the live check calling the handle available.
    expect(input(tree, 'Username').props.error).toBe('That username is already taken.');
  });

  it('brings the first refused field into view, in the order the form draws them', async () => {
    harness.api.updateProfile.mockRejectedValue(new ApiError('Please fix the highlighted fields.', 400, {
      fieldErrors: {
        tiktokHandle: 'Enter your TikTok username or profile link.',
        websiteUrl: 'Enter a website people can open.',
      },
    }));
    harness.fieldTops = { Website: 820, 'TikTok handle': 1180 };
    const tree = await renderScreen(newClient(storedProfile()));

    await type(tree, 'TikTok handle', 'x');
    await press(tree, 'Save profile');

    expect(input(tree, 'Website').props.error).toBe('Enter a website people can open.');
    expect(input(tree, 'TikTok handle').props.error).toBe('Enter your TikTok username or profile link.');
    expect(statusBlocks(tree)).toEqual([]);
    expect(harness.scrollView.scrollTo).toHaveBeenLastCalledWith({ y: 804, animated: true });
  });

  it('refuses what the form can judge itself under its field, with no block and no request', async () => {
    harness.fieldTops = { Username: 412 };
    const tree = await renderScreen(newClient(storedProfile()));

    await type(tree, 'Username', 'ab');
    await press(tree, 'Save profile');

    expect(input(tree, 'Username').props.error).toContain('3–24 lowercase letters');
    expect(harness.api.updateProfile).not.toHaveBeenCalled();
    expect(statusBlocks(tree)).toEqual([]);
    expect(harness.scrollView.scrollTo).toHaveBeenLastCalledWith({ y: 396, animated: true });
  });

  it('says a refusal that names no field in the block above the form, and brings the block into view', async () => {
    harness.api.updateProfile.mockRejectedValue(
      new ApiError('Network request failed. Please check your connection and try again.', 0, { url: 'https://api.example/profile' }),
    );
    harness.fieldTops = { Bio: 640 };
    const tree = await renderScreen(newClient(storedProfile()));

    await type(tree, 'Bio', 'New bio');
    await press(tree, 'Save profile');

    expect(statusBlocks(tree)).toEqual([
      { title: 'Profile not saved', body: 'Network request failed. Please check your connection and try again.' },
    ]);
    expect(harness.scrollView.scrollTo).toHaveBeenLastCalledWith({ y: 0, animated: true });
  });

  it('says an upload refused for another reason in the block, not under the handle', async () => {
    // A 409 with no field errors: the account is being deleted, not the handle taken.
    harness.uploadProfileImage.mockRejectedValue(new ApiError('Uploads are disabled because this account is being deleted.', 409, {
      error: 'Uploads are disabled because this account is being deleted.',
      code: 'ACCOUNT_DELETION_IN_PROGRESS',
    }));
    const tree = await renderScreen(newClient(storedProfile()));

    await press(tree, 'Change display photo');
    await press(tree, 'Save profile');

    expect(input(tree, 'Username').props.error).toBeUndefined();
    expect(statusBlocks(tree)).toEqual([
      { title: 'Profile not saved', body: 'Uploads are disabled because this account is being deleted.' },
    ]);
    expect(harness.scrollView.scrollTo).toHaveBeenLastCalledWith({ y: 0, animated: true });
  });

  it('brings a refused photo into view at the top of the form', async () => {
    harness.api.updateProfile.mockRejectedValue(new ApiError('Please fix the highlighted fields.', 400, {
      fieldErrors: { avatarUrl: 'Upload the display photo again.' },
    }));
    harness.fieldTops = { Username: 412 };
    const tree = await renderScreen(newClient(storedProfile()));

    await press(tree, 'Change display photo');
    await press(tree, 'Save profile');

    expect(tree.root.findAll((node) => String(node.type) === 'app-text' && node.props.children === 'Upload the display photo again.'))
      .toHaveLength(1);
    expect(statusBlocks(tree)).toEqual([]);
    // The photos head the form, and their verdicts sit under the preview there.
    expect(harness.scrollView.scrollTo).toHaveBeenLastCalledWith({ y: 0, animated: true });
  });

  it('jumps to the refusal rather than scrolling when motion is reduced', async () => {
    harness.api.updateProfile.mockRejectedValue(takenAtSave());
    harness.fieldTops = { Username: 412 };
    harness.reducedMotion = true;
    const tree = await renderScreen(newClient(storedProfile()));

    await typeHandleAndLetTheCheckAnswer(tree, 'maya');
    await press(tree, 'Save profile');

    expect(harness.scrollView.scrollTo).toHaveBeenLastCalledWith({ y: 396, animated: false });
  });
});

describe('Edit profile: picking photos', () => {
  it('takes the cover whole on iOS, as a JPEG, and crops the avatar square', async () => {
    const tree = await renderScreen(newClient(storedProfile()));

    await press(tree, 'Change cover');
    expect(harness.picker.launchImageLibraryAsync).toHaveBeenLastCalledWith({
      mediaTypes: ['images'],
      allowsEditing: false,
      preferredAssetRepresentationMode: 'compatible',
      quality: 0.6,
    });

    await press(tree, 'Change display photo');
    expect(harness.picker.launchImageLibraryAsync).toHaveBeenLastCalledWith({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.9,
    });
  });
});

// Signing in from a signed-out Edit profile ended on Home (audit 01-12).
describe('Edit profile: signed out', () => {
  it('signs in back to this form', async () => {
    harness.user = null;
    const tree = await renderScreen(newClient(storedProfile()));
    const signIn = tree.root.find((node) => String(node.type) === 'primary-button' && node.props.label === 'Sign in');

    await renderer.act(async () => { (signIn.props.onPress as () => void)(); });

    expect(harness.router.replace).toHaveBeenCalledWith({ pathname: '/auth', params: { returnTo: '/edit-profile' } });
  });
});
