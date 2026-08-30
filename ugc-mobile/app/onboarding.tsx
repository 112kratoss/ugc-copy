import { LinearGradient } from 'expo-linear-gradient';
import { Stack, router } from 'expo-router';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  ScrollView,
  Text,
  type TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AtSign, Clapperboard, ImageIcon, Sparkles, WandSparkles } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '@/lib/api-client';
import { isNetworkRequestFailedError } from '@/lib/supabase-auth-recovery';
import { useAuth } from '@/lib/auth';
import { useReducedMotion } from '@/lib/motion';
import { trackOnboardingEvent, useOnboarding } from '@/lib/onboarding';
import { resolveOnboardingDestination } from '@/lib/onboarding-destination';
import { appTheme } from '@/lib/theme';
import type { OnboardingGoal, ProfileResponse, WelcomeCreditResponse } from '@/lib/types';
import { AppText, AppTextInput, Card, Kicker, PrimaryButton, SecondaryButton } from '@/components/ui';
import { KeyboardAvoidingArea } from '@/components/keyboard-aware';
import {
  OnboardingBookletGoal,
  type BookletGoal,
} from '@/components/onboarding-booklet';
import { OnboardingHeader } from '@/components/onboarding-header';
import { OnboardingWelcome } from '@/components/onboarding-welcome';

import imagePreview from '../assets/images/onboarding-pages/image.jpg';
import videoPreview from '../assets/images/onboarding-pages/video.jpg';
import motionPreview from '../assets/images/onboarding-pages/motion.jpg';
import { haptic } from '@/lib/haptics';

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
  const { api, user, refreshProfile, updateCredits } = useAuth();
  const { state, update, skip, complete } = useOnboarding();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const [step, setStep] = useState(state.introStep);
  // A signed-in creator never belongs on the guest intro, so open straight into
  // `loading` and let the resolver pick the real stage. Seeding `intro` here is
  // what put an account holder on the welcome card while the profile fetch was
  // still in flight.
  const [stage, setStage] = useState<'intro' | 'loading' | 'identity' | 'reward'>(user ? 'loading' : 'intro');
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
  const previousUserRef = useRef<string | null>(user?.id ?? null);
  const rewardViewedTracked = useRef(false);
  const handleRef = useRef<TextInput | null>(null);
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
      // Resolved once, on entry. Re-deriving as state changes would eject
      // someone the instant `claimCredits` flips `eligible` to `claimed` —
      // mid-celebration, with the credits counter still animating.
      const destination = resolveOnboardingDestination({
        hasUser: true,
        welcome: nextWelcome,
        local: state,
      });
      if (destination === 'none') {
        // Nothing outstanding. Reaching here means a deep link or a stale card,
        // not a flow to walk.
        router.replace('/(tabs)' as never);
        return;
      }
      setStage(destination === 'reward' ? 'reward' : 'identity');
      // Only the goal. Sending `status: 'in_progress'` here is what demoted a
      // finished run one second after it completed — the server keeps its own
      // guard now, but the fix belongs at the source too.
      await update({ goal });
      await api.updateOnboardingState({ goal }).catch(() => undefined);
    } catch (error) {
      setMessage(isNetworkRequestFailedError(error)
        ? 'You appear to be offline. Check your connection and try again.'
        : 'We could not load your creator setup. Try again, or skip it for now — you can finish from Home.');
      setStage('loading');
    }
  }, [api, goal, state, update, user]);

  useEffect(() => {
    // Being signed in is the whole condition. This used to also require
    // `state.lastStep >= 4` — an install-local cursor — so the same account
    // entered the authenticated stages on one device and the guest welcome
    // screen on another.
    if (user) void loadAuthenticatedStage();
  }, [loadAuthenticatedStage, user]);

  useEffect(() => {
    // `auth_succeeded` used to key off a `resume=identity` param. Delivery of
    // that param to an already-mounted screen was never guaranteed —
    // `completeAuthScreen` prefers `router.dismissTo()` — so watch the session
    // transition instead, which is what the event actually means.
    const hadUser = previousUserRef.current;
    previousUserRef.current = user?.id ?? null;
    if (!hadUser && user && !authSucceededTracked.current) {
      authSucceededTracked.current = true;
      void trackOnboardingEvent(api, 'auth_succeeded', { goal, step: 'auth' });
    }
  }, [api, goal, user]);

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
    await update({ status: 'in_progress', introStep: nextStep, goal });
  };

  /**
   * Leave onboarding without finishing it.
   *
   * `skip()` marks the flow skipped rather than complete, so the entry points
   * can still offer the flow later — stepping out is deferring, not losing.
   *
   * Leaving the identity stage records the deferral. Without it the resolver
   * sends an unclaimed handle straight back to this same stage on the next
   * render, which is the old loop wearing a different hat: "later" has to mean
   * later. Settings still opens the flow whenever they want it.
   */
  const leaveForNow = async (fromStep: string) => {
    await (fromStep === 'identity'
      ? update({ status: 'skipped', identityDeferredAt: new Date().toISOString() })
      : skip());
    void trackOnboardingEvent(api, 'skipped', { goal, step: fromStep });
    router.replace('/(tabs)' as never);
  };

  const exploreAsGuest = () => leaveForNow(stage === 'intro' ? (step === 0 ? 'welcome' : 'goal') : stage);

  const continueToAuth = async () => {
    await update({ status: 'in_progress', introStep: 1, goal });
    // Already signed in — the sign-up screen has nothing to ask. It used to be
    // pushed anyway and bounced straight back out, which read as a flash of a
    // stranger's screen on the way to the identity step.
    if (user) {
      await loadAuthenticatedStage();
      return;
    }
    void trackOnboardingEvent(api, 'auth_started', { goal, step: 'auth' });
    router.push({
      pathname: '/auth',
      params: { mode: 'signup', returnTo: '/onboarding' },
    } as never);
  };

  const signInFromWelcome = async () => {
    await update({ status: 'in_progress', introStep: 0, goal });
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
      await update({ goal });
      await api.updateOnboardingState({ goal }).catch(() => undefined);
      void trackOnboardingEvent(api, 'username_saved', { goal, step: 'identity' });
      // The reward stage is for people who can actually claim. Anyone else —
      // most often an account that predates the grant program — has now
      // finished everything the flow can offer, so end it rather than show a
      // Creator Pack figure they will never receive.
      if (nextWelcome.status === 'eligible') {
        setStage('reward');
      } else {
        await startCreating();
      }
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
    haptic.success();
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
          : result.status === 'requires_account'
            ? 'Create an account to unlock your Creator Pack.'
            // The one-time pack was already claimed by a previous (since
            // deleted) account using this sign-in. Nothing was added, so this
            // branch must never reach celebrateCredits/updateCredits.
            : result.status === 'identity_already_claimed'
              ? 'This sign-in already received the one-time Creator Pack on a previous account.'
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
    router.replace({
      pathname: '/(tabs)/creator',
      params: { tool: goal, guided: '1' },
    } as never);
  };

  const claimReady = welcome?.status === 'eligible';
  const claimed = welcome?.status === 'claimed' || welcome?.status === 'already_claimed';
  // The figure is only meaningful to someone who is about to receive it or just
  // did. For everyone else `amount` falls back to the program default, which is
  // how an account holding 26,831 credits was shown a headline "25".
  const showAmount = claimReady || claimed;

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
      <KeyboardAvoidingArea iosScrollViewAdjustsInsets>
      <ScrollView
        automaticallyAdjustKeyboardInsets
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
        {/* `flexGrow` rather than `flex`: inside a scroll view `flex: 1` pins
            this to exactly the viewport height, so a stage taller than the
            screen is clipped instead of scrolled. The welcome stage still
            fills the screen, and the taller identity stage can now scroll. */}
        <View style={{ width: cardWidth, flexGrow: 1, gap: isWelcome ? 0 : 14 }}>
          {isWelcome ? (
            <OnboardingWelcome
              availableHeight={height - topPadding - bottomPadding}
              availableWidth={cardWidth}
              onGetStarted={() => {
                haptic.light();
                void moveToStep(1);
              }}
              onSignIn={() => void signInFromWelcome()}
              onSkip={() => void exploreAsGuest()}
            />
          ) : (
            <OnboardingHeader
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
                void update({ goal: nextGoal, status: 'in_progress', introStep: 1 });
              }}
              onContinue={() => void continueToAuth()}
              onBack={() => void moveToStep(0)}
            />
          ) : null}

          {stage === 'loading' ? (
            <Card style={{ marginTop: 40, alignItems: 'center', paddingVertical: 40 }}>
              <ActivityIndicator color={appTheme.colors.primary} />
              <AppText variant="cardTitle">Preparing your creator setup</AppText>
              <AppText variant="bodySm" color="muted">Checking your profile and Creator Pack.</AppText>
              {message ? <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={{ color: appTheme.colors.danger, textAlign: 'center' }}>{message}</Text> : null}
              {message ? <SecondaryButton label="Try again" onPress={() => void loadAuthenticatedStage()} /> : null}
              {/* Onboarding must stay optional even when it breaks. Without
                  this the stage has no Skip (the header only offers one during
                  `intro`) and the route disables the back gesture, so a failed
                  profile fetch held a signed-in creator on this card. */}
              {message ? <SecondaryButton label="Skip for now" onPress={() => void leaveForNow('loading')} /> : null}
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
                  textContentType="name"
                  returnKeyType="next"
                  submitBehavior="submit"
                  onSubmitEditing={() => handleRef.current?.focus()}
                  maxLength={60}
                  placeholder="Your creator name"
                />
                <View style={{ gap: 7 }}>
                  <View style={{ position: 'relative' }}>
                    <View pointerEvents="none" style={{ position: 'absolute', left: 14, top: 42, zIndex: 2 }}>
                      <AtSign size={18} color={appTheme.colors.muted} />
                    </View>
                    <AppTextInput
                      inputRef={handleRef}
                      label="Unique handle"
                      value={username}
                      onChangeText={(value) => setUsername(value.toLowerCase().replace(/^@+/, '').replace(/[^a-z0-9-]/g, ''))}
                      autoCapitalize="none"
                      autoCorrect={false}
                      spellCheck={false}
                      textContentType="nickname"
                      returnKeyType="done"
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
                {/* The flow has to stay optional: this stage offered no skip and
                    the route disables the back gesture, so a signed-in creator
                    was held here until they picked a handle. A generated one
                    already exists to fall back on. */}
                <SecondaryButton
                  label="Choose a name later"
                  disabled={busy}
                  onPress={() => void leaveForNow('identity')}
                />
              </Card>
            </>
          ) : null}

          {stage === 'reward' ? (
            <View style={{ flex: 1, justifyContent: 'center', gap: 18, paddingVertical: 24 }}>
              <Animated.View style={{ transform: [{ scale: rewardScale }] }}>
                <Card accent="primary" padding="lg" style={{ alignItems: 'center', paddingVertical: 34, gap: 16 }}>
                  <View style={{ width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.selectedStrong }}>
                    <Sparkles size={appTheme.icon.hero} color={appTheme.colors.primary} />
                  </View>
                  <View style={{ alignItems: 'center', gap: 8 }}>
                    <Kicker color="primary">Creator Pack</Kicker>
                    <AppText heading variant="pageTitle" style={{ textAlign: 'center' }}>
                      {claimed ? 'Your Creator Pack is ready' : 'Claim your Creator Pack'}
                    </AppText>
                    <AppText variant="bodySm" color="muted" style={{ textAlign: 'center' }}>
                      {claimed
                        ? 'Your creation credits are ready for your first project.'
                        : 'Claim creation-only credits for images, video, and motion.'}
                    </AppText>
                  </View>
                  {showAmount ? (
                    <View accessible accessibilityLiveRegion="polite" accessibilityLabel={`${isCelebrating ? animatedCredits : welcome?.amount} creation credits`} style={{ alignItems: 'center' }}>
                      <AppText variant="display" color="primary" style={{ fontVariant: ['tabular-nums'], fontSize: 52, lineHeight: 60 }}>{isCelebrating ? animatedCredits : welcome?.amount}</AppText>
                      <AppText variant="label" color="textSecondary">creation credits</AppText>
                    </View>
                  ) : null}
                  <AppText variant="caption" color="faint" style={{ textAlign: 'center' }}>Creation credits cannot be used for marketplace purchases.</AppText>
                </Card>
              </Animated.View>
              {message ? <Text accessibilityRole="alert" style={{ color: appTheme.colors.danger, textAlign: 'center' }}>{message}</Text> : null}
              {claimReady ? <PrimaryButton label={`Claim ${welcome?.amount} credits`} loading={busy} onPress={() => void claimCredits()} /> : null}
              {!claimReady || claimed ? <PrimaryButton label="Start creating" onPress={() => void startCreating()} /> : null}
              {/* An explicit way out. "Start creating" used to be the only exit
                  from this stage, and the route disables the back gesture, so
                  anyone who wanted neither the pack nor the guided creator was
                  held here. */}
              {claimReady ? <SecondaryButton label="Claim later" onPress={() => void startCreating()} /> : null}
            </View>
          ) : null}
        </View>
      </ScrollView>
      </KeyboardAvoidingArea>
    </View>
  );
}
