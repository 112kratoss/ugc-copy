import { useRoute } from '@react-navigation/native';

import { SignInWall } from '@/components/sign-in-wall';
import { authNoticeForRedirect } from '@/lib/auth-error-copy';
import { normalizeAuthReturnTo } from '@/lib/auth-navigation';
import { signInOpensOnEmailForm } from '@/lib/join-navigation';

/**
 * Where a sign-in begun here was headed, as the `step` of its analytics events
 * (audit 01-11): the return route's path, without a query that can carry what
 * someone searched for, and within the 64 characters the events route takes.
 */
function authAnalyticsStep(returnTo: string | string[] | undefined) {
  const destination = normalizeAuthReturnTo(returnTo) ?? '/(tabs)';
  return (destination.split(/[?#]/, 1)[0] || '/(tabs)').slice(0, 64);
}

/**
 * Every "Sign in" opens the full-screen sign-in page (owner, 2026-11-08: one page for signing
 * up and in, `components/sign-in-wall.tsx`), a redirect's notice ("You were signed out") on it
 * included, since most accounts come back with Apple or Google. Its email form is the same
 * page's second half, turned to in place; `email=1` opens the page on it.
 */
export default function AuthRoute() {
  // The route's own params: the URL parse has decoded them once, as every caller encoded its
  // return once. expo-router's `useLocalSearchParams` decodes them again, which cut a prompt in a
  // return at & or #, turned its + into a space, and sent one with a backslash or a line break Home.
  const { returnTo, notice, email, inPlace } = (useRoute().params ?? {}) as {
    returnTo?: string | string[];
    notice?: string | string[];
    email?: string | string[];
    inPlace?: string | string[];
  };
  const opensOnEmail = signInOpensOnEmailForm(email);
  const redirectNotice = authNoticeForRedirect(notice);

  return (
    <SignInWall
      target={normalizeAuthReturnTo(returnTo) ?? '/(tabs)'}
      step={authAnalyticsStep(returnTo)}
      notice={opensOnEmail ? null : redirectNotice}
      initialMode={opensOnEmail ? 'email' : 'choose'}
      emailReturnTo={returnTo}
      emailInPlace={inPlace}
      emailNotice={opensOnEmail ? redirectNotice : null}
    />
  );
}
