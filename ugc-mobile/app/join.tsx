// What a guest sees when they reach for something an account does (owner, 2026-11-08: Create,
// Generate, Remix, Like, Follow): the full-screen sign-in page with its wall of creations
// (`components/sign-in-wall.tsx`). Signing in goes on to the creator name and the welcome
// credits once, then back to what was tapped.
import { useRoute } from '@react-navigation/native';

import { SignInWall } from '@/components/sign-in-wall';
import { onboardingReturnTo } from '@/lib/join-navigation';

export default function JoinScreen() {
  const { returnTo } = (useRoute().params ?? {}) as { returnTo?: string | string[] };
  const target = onboardingReturnTo(returnTo) ?? '/(tabs)';

  return (
    <SignInWall
      target={target}
      step="join"
      // An email sign-in on the page's second half still meets a new account at the name and
      // credits: an existing, finished account passes straight through onboarding to `target`.
      emailReturnTo={`/onboarding?returnTo=${encodeURIComponent(target)}`}
    />
  );
}
