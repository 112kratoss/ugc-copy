// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The sign-in probes' verdicts, with Supabase, the callback's host, Google and
// Apple answered by a stub. A pass must mean each provider was seen to refuse a
// return URL nobody registered and to take the callback, and that the
// callback's host answers for the project (the runbook's "Custom auth domain").
const PROJECT_ORIGIN = 'https://ref.supabase.co';
const CALLBACK = 'https://auth.example.com/auth/v1/callback';
const UNREGISTERED = 'https://auth.example.com/external-gates-unregistered-return';
const GOOGLE_CLIENT = '123-abc.apps.googleusercontent.com';
const APPLE_CLIENT = 'com.example.app.web';

type World = {
  /** How the callback's host answers its authorize route. */
  host?: 'serves' | 'no-project' | 'certificate-refused';
  googleTakes?: (returnUrl: string) => boolean;
  appleTakes?: (returnUrl: string) => boolean;
  supabaseNamesNoClient?: boolean;
};

const registeredOnly = (returnUrl: string) => returnUrl === CALLBACK;

// Supabase's redirects as they were on 2026-11-28, with a state of its own.
function supabaseRedirectTo(provider: string | null) {
  const target = provider === 'google'
    ? new URL('https://accounts.google.com/o/oauth2/v2/auth')
    : new URL('https://appleid.apple.com/auth/authorize');
  target.search = new URLSearchParams({
    client_id: provider === 'google' ? GOOGLE_CLIENT : APPLE_CLIENT,
    redirect_to: 'https://magicbooklet.com/auth/callback',
    redirect_uri: CALLBACK,
    response_type: 'code',
    scope: provider === 'google' ? 'email profile' : 'email name',
    state: 'supabase-signed-state',
    ...(provider === 'apple' ? { response_mode: 'form_post' } : {}),
  }).toString();
  return target.toString();
}

function redirect(location: string) {
  return new Response(null, { status: 302, headers: { location } });
}

function applePage(direct: Record<string, unknown>) {
  return new Response(`<html><script type="application/json" class="boot_args">${JSON.stringify({ direct })}</script></html>`, {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
}

function stubWorld(world: World = {}) {
  const requests: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname === '/auth/v1/authorize') {
      if (url.origin === new URL(CALLBACK).origin) {
        if (world.host === 'certificate-refused') {
          throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } });
        }
        if (world.host === 'no-project') {
          return new Response('{"message":"Project not specified"}', { status: 400 });
        }
      } else if (url.origin !== PROJECT_ORIGIN) {
        throw new Error(`unexpected origin ${url.origin}`);
      }
      if (world.supabaseNamesNoClient) {
        return new Response('{"msg":"Unsupported provider: provider is not enabled"}', { status: 400 });
      }
      return redirect(supabaseRedirectTo(url.searchParams.get('provider')));
    }
    const returnUrl = url.searchParams.get('redirect_uri') ?? '';
    if (url.origin === 'https://accounts.google.com') {
      return redirect((world.googleTakes ?? registeredOnly)(returnUrl)
        ? 'https://accounts.google.com/v3/signin/identifier?flowName=GeneralOAuthFlow'
        : 'https://accounts.google.com/signin/oauth/error?authError=x');
    }
    if (url.origin === 'https://appleid.apple.com') {
      return applePage((world.appleTakes ?? registeredOnly)(returnUrl)
        ? { appleOAuth: { clientId: APPLE_CLIENT } }
        : { errorCode: 'invalid_request', errorMessage: 'Invalid web redirect url.' });
    }
    throw new Error(`unexpected request ${url}`);
  }));
  return requests;
}

// The script reads its project and callback as it loads.
async function loadGates() {
  vi.stubEnv('SUPABASE_PROJECT_REF', 'ref');
  vi.stubEnv('SUPABASE_AUTH_CALLBACK_URL', `  ${CALLBACK}\n`);
  vi.stubEnv('SUPABASE_MANAGEMENT_API_TOKEN', '');
  vi.stubEnv('SUPABASE_ACCESS_TOKEN', '');
  vi.resetModules();
  return import('../../scripts/ops/production-external-gates.mjs');
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('--probe-google-sign-in', () => {
  it('passes once Google refuses the control, takes the callback, and the callback host answers', async () => {
    const requests = stubWorld();
    const { probeGoogleWebSignIn } = await loadGates();

    await expect(probeGoogleWebSignIn()).resolves.toBeUndefined();
    const toGoogle = requests.filter((url) => url.origin === 'https://accounts.google.com');
    // The control goes first, and differs from Supabase's own request only in its return URL.
    expect(toGoogle.map((url) => url.searchParams.get('redirect_uri'))).toEqual([UNREGISTERED, CALLBACK]);
    const supabaseRequest = Object.fromEntries(new URL(supabaseRedirectTo('google')).searchParams);
    expect(Object.fromEntries(toGoogle[0].searchParams)).toEqual({ ...supabaseRequest, redirect_uri: UNREGISTERED });
    expect(requests.some((url) => url.origin === 'https://auth.example.com')).toBe(true);
  });

  it('fails when Google takes a return URL nobody registered, since it could not see a refusal', async () => {
    stubWorld({ googleTakes: () => true });
    const { probeGoogleWebSignIn } = await loadGates();

    await expect(probeGoogleWebSignIn()).rejects.toThrow(/took https:\/\/auth\.example\.com\/external-gates-unregistered-return.*cannot see its refusals/);
  });

  it('fails when Google refuses the callback', async () => {
    stubWorld({ googleTakes: () => false });
    const { probeGoogleWebSignIn } = await loadGates();

    await expect(probeGoogleWebSignIn()).rejects.toThrow(/Google refuses https:\/\/auth\.example\.com\/auth\/v1\/callback/);
  });

  it('fails when the callback host answers for no project, as before activation', async () => {
    stubWorld({ host: 'no-project' });
    const { probeGoogleWebSignIn } = await loadGates();

    await expect(probeGoogleWebSignIn()).rejects.toThrow(/callback's host https:\/\/auth\.example\.com does not answer .*HTTP 400.*Project not specified/);
  });

  it("fails when the callback host's certificate is refused", async () => {
    stubWorld({ host: 'certificate-refused' });
    const { probeGoogleWebSignIn } = await loadGates();

    await expect(probeGoogleWebSignIn()).rejects.toThrow(/callback's host https:\/\/auth\.example\.com does not answer .*CERT_HAS_EXPIRED/);
  });
});

describe('--probe-apple-web-sign-in', () => {
  it('passes when Supabase sends Apple the callback and its host answers, without asking Apple', async () => {
    const requests = stubWorld();
    const { probeAppleWebSignIn } = await loadGates();

    await expect(probeAppleWebSignIn()).resolves.toBeUndefined();
    expect(requests.some((url) => url.origin === 'https://auth.example.com')).toBe(true);
    expect(requests.some((url) => url.origin === 'https://appleid.apple.com')).toBe(false);
  });

  it('fails when the callback host does not answer', async () => {
    stubWorld({ host: 'no-project' });
    const { probeAppleWebSignIn } = await loadGates();

    await expect(probeAppleWebSignIn()).rejects.toThrow(/Apple web sign-in probe failed: the callback's host https:\/\/auth\.example\.com does not answer/);
  });
});

describe('--probe-auth-callback-registrations', () => {
  it('passes when both providers refuse the control and take the callback, and never asks the callback host', async () => {
    const requests = stubWorld();
    const { probeAuthCallbackRegistrations } = await loadGates();

    await expect(probeAuthCallbackRegistrations()).resolves.toBeUndefined();
    for (const origin of ['https://accounts.google.com', 'https://appleid.apple.com']) {
      expect(requests.filter((url) => url.origin === origin).map((url) => url.searchParams.get('redirect_uri'))).toEqual([UNREGISTERED, CALLBACK]);
    }
    expect(requests.some((url) => url.origin === 'https://auth.example.com')).toBe(false);
  });

  it('fails when Apple takes a return URL nobody registered', async () => {
    stubWorld({ appleTakes: () => true });
    const { probeAuthCallbackRegistrations } = await loadGates();

    await expect(probeAuthCallbackRegistrations()).rejects.toThrow(/Apple took https:\/\/auth\.example\.com\/external-gates-unregistered-return.*cannot see its refusals/);
  });

  it('names both refusals when neither provider takes the callback', async () => {
    stubWorld({ googleTakes: () => false, appleTakes: () => false });
    const { probeAuthCallbackRegistrations } = await loadGates();

    const failure = probeAuthCallbackRegistrations();
    await expect(failure).rejects.toThrow(/Google refuses https:\/\/auth\.example\.com\/auth\/v1\/callback/);
    await expect(failure).rejects.toThrow(/Apple refuses https:\/\/auth\.example\.com\/auth\/v1\/callback .*Invalid web redirect url/);
  });

  it('fails when Supabase names no client', async () => {
    stubWorld({ supabaseNamesNoClient: true });
    const { probeAuthCallbackRegistrations } = await loadGates();

    await expect(probeAuthCallbackRegistrations()).rejects.toThrow(/Continue with google names no client \(HTTP 400/);
  });
});
