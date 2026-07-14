import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AtSign, Clapperboard, ImageIcon, Sparkles, WandSparkles } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { useReducedMotion } from '@/lib/motion';
import { trackOnboardingEvent, useOnboarding } from '@/lib/onboarding';
import { appTheme } from '@/lib/theme';
import type { OnboardingGoal, ProfileResponse, WelcomeCreditResponse } from '@/lib/types';
import { AppText, AppTextInput, Card, Kicker, PrimaryButton, SecondaryButton } from '@/components/ui';
import {
  OnboardingBookletGoal,
  OnboardingBookletHeader,
  type BookletGoal,
} from '@/components/onboarding-booklet';
import { OnboardingWelcome } from '@/components/onboarding-welcome';

import imagePreview from '../assets/images/onboarding-pages/image.png';
import videoPreview from '../assets/images/onboarding-pages/video.png';
import motionPreview from '../assets/images/onboarding-pages/motion.png';

const GOALS: BookletGoal[] = [
  {
    id: 'image',
    label: 'Image',
    body: 'Campaign visuals and product shots',
    color: appTheme.colors.image,
    image: imagePreview,
    imageLabel: 'A cinematic mountain landscape created with Magicbooklet',
    icon: ImageIcon,
  },
  {
    id: 'video',
    label: 'Video',
    body: 'Ads, reels, and story-driven clips',
    color: appTheme.colors.video,
    image: videoPreview,
    imageLabel: 'A cinematic creator portrait created for a video',
    icon: Clapperboard,
  },
  {
    id: 'motion',
    label: 'Motion',
    body: 'Animate a character or reference video',
    color: appTheme.colors.motion,
    image: motionPreview,
    imageLabel: 'An energetic purple motion scene created with Magicbooklet',
    icon: WandSparkles,
  },
];

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function isClaimedIdentity(profile: ProfileResponse | null) {
  const username = profile?.username?.trim() ?? '';
  return /^[a-z0-9-]{3,24}$/.test(username)
    && !/^creator-[a-f0-9]{8}$/.test(username)
    && Boolean(profile?.displayName?.trim());
}

function authDisplayName(metadata: Record<string, unknown> | undefined) {
  const candidate = metadata?.full_name ?? metadata?.name;
  return typeof candidate === 'string' ? candidate.trim() : '';
}

function profileUpdatePayload(profile: ProfileResponse, username: string, displayName: string) {
  return {
    username,
    displayName,
    bio: profile.bio,
    avatarUrl: profile.avatarUrl,
    coverUrl: profile.coverUrl,
    websiteUrl: profile.websiteUrl,
    twitterHandle: profile.twitterHandle,
    instagramHandle: profile.instagramHandle,
    tiktokHandle: profile.tiktokHandle,
    location: profile.location,
  };
}

export default function OnboardingScreen() {
  const params = useLocalSearchParams<{ resume?: string | string[] }>();
  const resume = firstParam(params.resume);
  const { api, user, refreshProfile, updateCredits } = useAuth();
  const { state, update, skip, complete } = useOnboarding();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const [step, setStep] = useState(state.lastStep === 0 ? 0 : 1);
  const [stage, setStage] = useState<'intro' | 'loading' | 'identity' | 'reward'>('intro');
  const [goal, setGoal] = useState<OnboardingGoal>(state.goal);
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [welcome, setWelcome] = useState<WelcomeCreditResponse | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [usernameState, setUsernameState] = useState<'idle' | 'checking' | 'available' | 'error'>('idle');
  const [usernameMessage, setUsernameMessage] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [animatedCredits, setAnimatedCredits] = useState(0);
  const [isCelebrating, setIsCelebrating] = useState(false);
  const rewardScale = useRef(new Animated.Value(1)).current;
  const authSucceededTracked = useRef(false);
  const rewardViewedTracked = useRef(false);
  const cardWidth = Math.min(520, width - 32);
  const isWelcome = stage === 'intro' && step === 0;
  const topPadding = Math.max(insets.top, 16) + 8;
  const bottomPadding = Math.max(insets.bottom, 16) + (isWelcome ? 10 : 16);

  const loadAuthenticatedStage = useCallback(async () => {
    if (!user) return;
    setStage('loading');
    setMessage(null);
    try {
      const [nextProfile, nextWelcome] = await Promise.all([
        api.getProfile(),
        api.getWelcomeCredits(),
      ]);
      setProfile(nextProfile);
      setWelcome(nextWelcome);
      setDisplayName(nextProfile.displayName?.trim() || authDisplayName(user.user_metadata) || user.email?.split('@')[0] || 'Creator');
      setUsername(/^creator-[a-f0-9]{8}$/.test(nextProfile.username ?? '') ? '' : nextProfile.username ?? '');
      const identityComplete = isClaimedIdentity(nextProfile);
      const nextStage = identityComplete ? 'reward' : 'identity';
      setStage(nextStage);
      await update({ status: 'in_progress', lastStep: identityComplete ? 5 : 4, goal });
      await api.updateOnboardingState({ status: 'in_progress', goal }).catch(() => undefined);
      if (resume === 'identity' && !authSucceededTracked.current) {
        authSucceededTracked.current = true;
        void trackOnboardingEvent(api, 'auth_succeeded', { goal, step: 'auth' });
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not continue onboarding.');
      setStage('loading');
    }
  }, [api, goal, resume, update, user]);

  useEffect(() => {
    if (user && (resume === 'identity' || state.lastStep >= 4)) {
      void loadAuthenticatedStage();
    }
  }, [loadAuthenticatedStage, resume, state.lastStep, user]);

  useEffect(() => {
    if (stage !== 'intro') return;
    const key = step === 0 ? 'welcome' : 'goal';
    void trackOnboardingEvent(api, step === 0 ? 'started' : 'screen_viewed', { goal, step: key });
  }, [api, goal, stage, step]);

  useEffect(() => {
    if (stage !== 'reward' || rewardViewedTracked.current) return;
    rewardViewedTracked.current = true;
    setAnimatedCredits(welcome?.status === 'eligible' ? 0 : welcome?.amount ?? 25);
    void trackOnboardingEvent(api, 'reward_viewed', { goal, step: 'reward' });
  }, [api, goal, stage, welcome]);

  useEffect(() => {
    if (stage !== 'identity') return;
    const normalized = username.trim().replace(/^@+/, '').toLowerCase();
    if (!/^[a-z0-9-]{3,24}$/.test(normalized) || !displayName.trim()) {
      setUsernameState('idle');
      setUsernameMessage(null);
      return;
    }
    setUsernameState('checking');
    const timer = setTimeout(() => {
      void api.validateProfile({ username: normalized, displayName: displayName.trim() })
        .then(() => {
          setUsernameState('available');
          setUsernameMessage('This creator name is available.');
        })
        .catch((error) => {
          setUsernameState('error');
          setUsernameMessage(error instanceof Error ? error.message : 'This creator name is unavailable.');
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [api, displayName, stage, username]);

  const moveToStep = async (nextStep: number) => {
    setStep(nextStep);
    await update({ status: 'in_progress', lastStep: nextStep, goal });
  };

  const exploreAsGuest = async () => {
    await skip();
    void trackOnboardingEvent(api, 'skipped', { goal, step: stage === 'intro' ? (step === 0 ? 'welcome' : 'goal') : stage });
    router.replace('/(tabs)' as never);
  };

  const continueToAuth = async () => {
    await update({ status: 'in_progress', lastStep: 4, goal });
    void trackOnboardingEvent(api, 'auth_started', { goal, step: 'auth' });
    router.push({
      pathname: '/auth',
      params: { mode: 'signup', returnTo: '/onboarding?resume=identity' },
    } as never);
  };

  const signInFromWelcome = async () => {
    await update({ status: 'in_progress', lastStep: 0, goal });
    void trackOnboardingEvent(api, 'auth_started', { goal, step: 'welcome-sign-in' });
    router.push({
      pathname: '/auth',
      params: { mode: 'login', returnTo: '/(tabs)' },
    } as never);
  };

  const saveIdentity = async () => {
    if (!profile || busy) return;
    const normalizedUsername = username.trim().replace(/^@+/, '').toLowerCase();
    if (!displayName.trim()) {
      setMessage('Add the name you want people to see.');
      return;
    }
    if (!/^[a-z0-9-]{3,24}$/.test(normalizedUsername) || /^creator-[a-f0-9]{8}$/.test(normalizedUsername)) {
      setMessage('Use 3–24 lowercase letters, numbers, or hyphens for your handle.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const payload = profileUpdatePayload(profile, normalizedUsername, displayName.trim());
      await api.validateProfile(payload);
      const updatedProfile = await api.updateProfile(payload);
      const nextWelcome = await api.getWelcomeCredits();
      setProfile(updatedProfile);
      setWelcome(nextWelcome);
      await refreshProfile();
      await update({ status: 'in_progress', lastStep: 5, goal });
      await api.updateOnboardingState({ status: 'in_progress', goal }).catch(() => undefined);
      void trackOnboardingEvent(api, 'username_saved', { goal, step: 'identity' });
      setStage('reward');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setUsernameState('error');
        setUsernameMessage('That handle was just claimed. Try another one.');
        void trackOnboardingEvent(api, 'username_conflict', { goal, step: 'identity' });
      }
      setMessage(error instanceof Error ? error.message : 'Could not save your creator name.');
    } finally {
      setBusy(false);
    }
  };

  const celebrateCredits = async (amount: number) => {
    setIsCelebrating(true);
    if (reducedMotion) {
      setAnimatedCredits(amount);
    } else {
      setAnimatedCredits(0);
      const started = Date.now();
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          const progress = Math.min(1, (Date.now() - started) / 850);
          setAnimatedCredits(Math.round(amount * progress));
          if (progress >= 1) {
            clearInterval(timer);
            resolve();
          }
        }, 32);
      });
      Animated.sequence([
        Animated.spring(rewardScale, { toValue: 1.08, useNativeDriver: true, speed: 18 }),
        Animated.spring(rewardScale, { toValue: 1, useNativeDriver: true, speed: 18 }),
      ]).start();
    }
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    AccessibilityInfo.announceForAccessibility(`${amount} creation credits added.`);
    setIsCelebrating(false);
  };

  const claimCredits = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.claimWelcomeCredits();
      setWelcome(result);
      if (result.status === 'claimed' || result.status === 'already_claimed') {
        updateCredits(result.credits);
        await celebrateCredits(result.amount);
        void trackOnboardingEvent(api, 'reward_claimed', { goal, step: 'reward' });
      } else {
        setMessage(result.status === 'unavailable'
          ? 'Your Creator Pack is temporarily unavailable. You can continue and claim it from Home.'
          : 'Finish your creator name before claiming this reward.');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not claim credits.');
      void trackOnboardingEvent(api, 'reward_failed', { goal, step: 'reward' });
    } finally {
      setBusy(false);
    }
  };

  const startCreating = async () => {
    await complete();
    await api.updateOnboardingState({ status: 'completed', goal }).catch(() => undefined);
    if (welcome?.status === 'eligible' || welcome?.status === 'unavailable') {
      void trackOnboardingEvent(api, 'reward_deferred', { goal, step: 'reward' });
    }
    void trackOnboardingEvent(api, 'guided_creator_opened', { goal, step: 'creator' });
    router.replace(`/create/${goal}?guided=1` as never);
  };

  const claimReady = welcome?.status === 'eligible';
  const claimed = welcome?.status === 'claimed' || welcome?.status === 'already_claimed';
  const legacy = welcome?.status === 'legacy_ineligible';

  return (
    <View style={{ flex: 1, backgroundColor: appTheme.colors.background }}>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <LinearGradient
        colors={isWelcome
          ? ['#08080b', '#0c0c0e', '#08080a']
          : ['#151114', appTheme.colors.background, '#0c0c0e']}
        locations={[0, 0.55, 1]}
        style={{ position: 'absolute', inset: 0 }}
      />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          flexGrow: 1,
          paddingTop: topPadding,
          paddingBottom: bottomPadding,
          paddingHorizontal: 16,
          alignItems: 'center',
        }}
      >
        <View style={{ width: cardWidth, flex: 1, gap: isWelcome ? 0 : 14 }}>
          {isWelcome ? (
            <OnboardingWelcome
              availableHeight={height - topPadding - bottomPadding}
              availableWidth={cardWidth}
              onGetStarted={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
                void moveToStep(1);
              }}
              onSignIn={() => void signInFromWelcome()}
            />
          ) : (
            <OnboardingBookletHeader
              onSkip={stage === 'intro' ? () => void exploreAsGuest() : undefined}
            />
          )}

          {stage === 'intro' && step > 0 ? (
            <OnboardingBookletGoal
              goals={GOALS}
              selectedGoal={goal}
              availableWidth={cardWidth}
              onSelect={(nextGoal) => {
                setGoal(nextGoal);
                void update({ goal: nextGoal, status: 'in_progress', lastStep: 1 });
              }}
              onContinue={() => void continueToAuth()}
              onExploreAsGuest={() => void exploreAsGuest()}
              onBack={() => void moveToStep(0)}
            />
          ) : null}

          {stage === 'loading' ? (
            <Card style={{ marginTop: 40, alignItems: 'center', paddingVertical: 40 }}>
              <ActivityIndicator color={appTheme.colors.primary} />
              <AppText variant="cardTitle">Preparing your creator setup</AppText>
              <AppText variant="bodySm" color="muted">Checking your profile and Creator Pack.</AppText>
              {message ? <Text accessibilityRole="alert" style={{ color: appTheme.colors.danger, textAlign: 'center' }}>{message}</Text> : null}
              {message ? <SecondaryButton label="Try again" onPress={() => void loadAuthenticatedStage()} /> : null}
            </Card>
          ) : null}

          {stage === 'identity' ? (
            <>
              <View style={{ gap: 8 }}>
                <Kicker color="primary">Creator identity</Kicker>
                <AppText heading variant="pageTitle">Claim your creator name</AppText>
                <AppText variant="bodySm" color="muted">This is the name people will see on your posts, profile, and unlocks.</AppText>
              </View>
              <Card padding="lg" style={{ gap: 18 }}>
                <AppTextInput
                  label="Display name"
                  value={displayName}
                  onChangeText={setDisplayName}
                  autoCapitalize="words"
                  autoComplete="name"
                  maxLength={60}
                  placeholder="Your creator name"
                />
                <View style={{ gap: 7 }}>
                  <View style={{ position: 'relative' }}>
                    <View pointerEvents="none" style={{ position: 'absolute', left: 14, top: 42, zIndex: 2 }}>
                      <AtSign size={18} color={appTheme.colors.muted} />
                    </View>
                    <AppTextInput
                      label="Unique handle"
                      value={username}
                      onChangeText={(value) => setUsername(value.toLowerCase().replace(/^@+/, '').replace(/[^a-z0-9-]/g, ''))}
                      autoCapitalize="none"
                      autoCorrect={false}
                      maxLength={24}
                      placeholder="your-name"
                      style={{ paddingLeft: 38 }}
                    />
                  </View>
                  <AppText
                    accessibilityLiveRegion="polite"
                    variant="caption"
                    color={usernameState === 'error' ? 'danger' : usernameState === 'available' ? 'success' : 'muted'}
                  >
                    {usernameState === 'checking' ? 'Checking availability…' : usernameMessage ?? '3–24 lowercase letters, numbers, or hyphens.'}
                  </AppText>
                </View>
                {message ? <Text accessibilityRole="alert" style={{ color: appTheme.colors.danger }}>{message}</Text> : null}
                <PrimaryButton
                  label="Save creator name"
                  loading={busy}
                  disabled={!displayName.trim() || !/^[a-z0-9-]{3,24}$/.test(username) || usernameState === 'error'}
                  onPress={() => void saveIdentity()}
                />
              </Card>
            </>
          ) : null}

          {stage === 'reward' ? (
            <View style={{ flex: 1, justifyContent: 'center', gap: 18, paddingVertical: 24 }}>
              <Animated.View style={{ transform: [{ scale: rewardScale }] }}>
                <Card accent="primary" padding="lg" style={{ alignItems: 'center', paddingVertical: 34, gap: 16 }}>
                  <View style={{ width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.selectedStrong }}>
                    <Sparkles size={34} color={appTheme.colors.primary} />
                  </View>
                  <View style={{ alignItems: 'center', gap: 8 }}>
                    <Kicker color="primary">Creator Pack</Kicker>
                    <AppText heading variant="pageTitle" style={{ textAlign: 'center' }}>Your Creator Pack is ready</AppText>
                    <AppText variant="bodySm" color="muted" style={{ textAlign: 'center' }}>
                      {legacy
                        ? 'Your existing welcome credits are already in your balance.'
                        : claimed
                          ? 'Your creation credits are ready for your first project.'
                          : 'Claim creation-only credits for images, video, and motion.'}
                    </AppText>
                  </View>
                  <View accessible accessibilityLiveRegion="polite" accessibilityLabel={`${isCelebrating ? animatedCredits : welcome?.amount ?? 25} creation credits`} style={{ alignItems: 'center' }}>
                    <AppText variant="display" color="primary" style={{ fontVariant: ['tabular-nums'], fontSize: 52, lineHeight: 60 }}>{isCelebrating ? animatedCredits : welcome?.amount ?? 25}</AppText>
                    <AppText variant="label" color="textSecondary">creation credits</AppText>
                  </View>
                  <AppText variant="caption" color="faint" style={{ textAlign: 'center' }}>Creation credits cannot be used for marketplace purchases.</AppText>
                </Card>
              </Animated.View>
              {message ? <Text accessibilityRole="alert" style={{ color: appTheme.colors.danger, textAlign: 'center' }}>{message}</Text> : null}
              {claimReady ? <PrimaryButton label={`Claim ${welcome?.amount ?? 25} credits`} loading={busy} onPress={() => void claimCredits()} /> : null}
              {!claimReady || claimed ? <PrimaryButton label="Start creating" onPress={() => void startCreating()} /> : null}
              {claimReady ? <SecondaryButton label="Claim later" onPress={() => void startCreating()} /> : null}
            </View>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}
