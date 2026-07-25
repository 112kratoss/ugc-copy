import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import type { SupabaseClient, User } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  ONBOARDING_EVENT_RATE_LIMIT,
  ONBOARDING_STATE_RATE_LIMIT,
  WELCOME_CREDIT_CLAIM_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  ONBOARDING_FLOW_VERSION,
  ONBOARDING_VARIANT,
  WELCOME_CREDIT_PROGRAM_KEY,
  hasClaimedCreatorIdentity,
  isOnboardingEventName,
  isOnboardingGoal,
  isOnboardingStatus,
  isValidOnboardingClientEventId,
  isValidOnboardingInstallationId,
  type OnboardingGoal,
  type OnboardingStatus,
  type WelcomeCreditStatus,
} from '@/lib/onboarding';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type Dependencies = {
  createServiceClient?: () => SupabaseClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  logError?: typeof logBackendRouteError;
};

type OnboardingStateRow = {
  user_id: string;
  flow_version: number;
  status: OnboardingStatus;
  goal: OnboardingGoal | null;
  username_completed_at: string | null;
  reward_claimed_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

type WelcomeProgramRow = {
  program_key: string;
  amount: number;
  promotional_amount: number;
  enabled: boolean;
  activated_at: string | null;
};

type WelcomeGrantRow = {
  amount: number;
  promotional_amount: number;
  credits_balance_after: number;
  promotional_credits_balance_after: number;
  claimed_at: string;
};

type WelcomeProfileRow = {
  credits: number | null;
  promotional_credits: number | null;
  username: string | null;
  display_name: string | null;
};

function resolveDependencies(dependencies?: Dependencies) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    logError: dependencies?.logError ?? logBackendRouteError,
  };
}

function privateJson(request: Request, body: unknown, status = 200) {
  return applyPrivateNoStoreApiResponseHeaders(
    NextResponse.json(body, { status }),
    request,
  );
}

async function authenticate(request: Request, dependencies: ReturnType<typeof resolveDependencies>) {
  const client = dependencies.createUserClient(request);
  const {
    data: { user },
    error,
  } = await client.auth.getUser();
  return error || !user ? null : user;
}

async function rateLimit(
  request: Request,
  admin: SupabaseClient,
  dependencies: ReturnType<typeof resolveDependencies>,
  configuration: { scope: string; limit: number; windowSeconds: number },
  key: string,
) {
  try {
    await dependencies.enforceBackendRateLimit(admin, { ...configuration, key });
    return null;
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return applyPrivateNoStoreApiResponseHeaders(createBackendRateLimitResponse(error), request);
    }
    throw error;
  }
}

function serializeState(row: OnboardingStateRow | null) {
  return {
    flowVersion: row?.flow_version ?? ONBOARDING_FLOW_VERSION,
    status: row?.status ?? 'not_started',
    goal: row?.goal ?? null,
    usernameCompletedAt: row?.username_completed_at ?? null,
    rewardClaimedAt: row?.reward_claimed_at ?? null,
    completedAt: row?.completed_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

async function loadWelcomeCreditStatus(admin: SupabaseClient, user: User) {
  const [{ data: program, error: programError }, { data: grant, error: grantError }, { data: profile, error: profileError }] = await Promise.all([
    admin
      .from('credit_grant_programs')
      .select('program_key,amount,promotional_amount,enabled,activated_at')
      .eq('program_key', WELCOME_CREDIT_PROGRAM_KEY)
      .maybeSingle(),
    admin
      .from('credit_grants')
      .select('amount,promotional_amount,credits_balance_after,promotional_credits_balance_after,claimed_at')
      .eq('user_id', user.id)
      .eq('program_key', WELCOME_CREDIT_PROGRAM_KEY)
      .maybeSingle(),
    admin
      .from('profiles')
      .select('credits,promotional_credits,username,display_name')
      .eq('id', user.id)
      .maybeSingle(),
  ]);

  if (programError || grantError || profileError) {
    throw programError ?? grantError ?? profileError;
  }

  const typedProgram = program as WelcomeProgramRow | null;
  const typedGrant = grant as WelcomeGrantRow | null;
  const typedProfile = profile as WelcomeProfileRow | null;
  const identityComplete = typedProfile ? hasClaimedCreatorIdentity(typedProfile) : false;
  const fallbackAmount = typedProgram?.amount ?? 25;
  const fallbackPromotionalAmount = typedProgram?.promotional_amount ?? 25;
  let status: WelcomeCreditStatus;

  if (typedGrant) {
    status = 'already_claimed';
  } else if (!typedProgram?.enabled || !typedProgram.activated_at) {
    status = (typedProfile?.credits ?? 0) >= fallbackAmount ? 'legacy_ineligible' : 'unavailable';
  } else if (new Date(user.created_at).getTime() < new Date(typedProgram.activated_at).getTime()) {
    status = 'legacy_ineligible';
  } else if (!identityComplete) {
    status = 'not_eligible';
  } else {
    status = 'eligible';
  }

  return {
    programKey: WELCOME_CREDIT_PROGRAM_KEY,
    status,
    amount: typedGrant?.amount ?? fallbackAmount,
    promotionalAmount: typedGrant?.promotional_amount ?? fallbackPromotionalAmount,
    credits: typedGrant?.credits_balance_after ?? typedProfile?.credits ?? 0,
    promotionalCredits: typedGrant?.promotional_credits_balance_after ?? typedProfile?.promotional_credits ?? 0,
    claimedAt: typedGrant?.claimed_at ?? null,
    identityComplete,
  };
}

export async function getOnboardingStateRouteResponse({
  request,
  dependencies,
}: {
  request: Request;
  dependencies?: Dependencies;
}) {
  const resolved = resolveDependencies(dependencies);
  try {
    const user = await authenticate(request, resolved);
    if (!user) return privateJson(request, { error: 'Unauthorized' }, 401);
    const admin = resolved.createServiceClient();
    const limited = await rateLimit(request, admin, resolved, ONBOARDING_STATE_RATE_LIMIT, user.id);
    if (limited) return limited;

    const { data, error } = await admin
      .from('mobile_onboarding_states')
      .select('user_id,flow_version,status,goal,username_completed_at,reward_claimed_at,completed_at,updated_at')
      .eq('user_id', user.id)
      .eq('flow_version', ONBOARDING_FLOW_VERSION)
      .maybeSingle();
    if (error) throw error;

    return privateJson(request, { state: serializeState(data as OnboardingStateRow | null) });
  } catch (error) {
    resolved.logError('Onboarding state GET failed:', error);
    return privateJson(request, { error: 'Could not load onboarding state.' }, 500);
  }
}

export async function patchOnboardingStateRouteResponse({
  request,
  dependencies,
}: {
  request: Request;
  dependencies?: Dependencies;
}) {
  const resolved = resolveDependencies(dependencies);
  try {
    const user = await authenticate(request, resolved);
    if (!user) return privateJson(request, { error: 'Unauthorized' }, 401);
    const body = await request.json() as { status?: unknown; goal?: unknown };
    if (body.status !== undefined && !isOnboardingStatus(body.status)) {
      return privateJson(request, { error: 'Invalid onboarding status.' }, 400);
    }
    if (body.goal !== undefined && body.goal !== null && !isOnboardingGoal(body.goal)) {
      return privateJson(request, { error: 'Invalid onboarding goal.' }, 400);
    }

    const admin = resolved.createServiceClient();
    const limited = await rateLimit(request, admin, resolved, ONBOARDING_STATE_RATE_LIMIT, user.id);
    if (limited) return limited;
    const { data: profile, error: profileError } = await admin
      .from('profiles')
      .select('username,display_name')
      .eq('id', user.id)
      .maybeSingle();
    if (profileError) throw profileError;

    const now = new Date().toISOString();
    const status = (body.status ?? 'in_progress') as OnboardingStatus;
    const payload = {
      user_id: user.id,
      flow_version: ONBOARDING_FLOW_VERSION,
      status,
      ...(body.goal !== undefined ? { goal: body.goal as OnboardingGoal | null } : {}),
      ...(profile && hasClaimedCreatorIdentity(profile) ? { username_completed_at: now } : {}),
      ...(status === 'completed' ? { completed_at: now } : {}),
    };
    const { data, error } = await admin
      .from('mobile_onboarding_states')
      .upsert(payload, { onConflict: 'user_id,flow_version' })
      .select('user_id,flow_version,status,goal,username_completed_at,reward_claimed_at,completed_at,updated_at')
      .single();
    if (error) throw error;

    return privateJson(request, { state: serializeState(data as OnboardingStateRow) });
  } catch (error) {
    resolved.logError('Onboarding state PATCH failed:', error);
    return privateJson(request, { error: 'Could not update onboarding state.' }, 500);
  }
}

export async function getWelcomeCreditsRouteResponse({
  request,
  dependencies,
}: {
  request: Request;
  dependencies?: Dependencies;
}) {
  const resolved = resolveDependencies(dependencies);
  try {
    const user = await authenticate(request, resolved);
    if (!user) return privateJson(request, { error: 'Unauthorized' }, 401);
    const status = await loadWelcomeCreditStatus(resolved.createServiceClient(), user);
    return privateJson(request, status);
  } catch (error) {
    resolved.logError('Welcome credits GET failed:', error);
    return privateJson(request, { error: 'Could not load welcome credits.' }, 500);
  }
}

export async function postWelcomeCreditsClaimRouteResponse({
  request,
  dependencies,
}: {
  request: Request;
  dependencies?: Dependencies;
}) {
  const resolved = resolveDependencies(dependencies);
  try {
    const user = await authenticate(request, resolved);
    if (!user) return privateJson(request, { error: 'Unauthorized' }, 401);
    const body = await request.json().catch(() => ({})) as { sourceSurface?: unknown };
    const sourceSurface = body.sourceSurface === 'web' ? 'web' : 'mobile';
    const admin = resolved.createServiceClient();
    const limited = await rateLimit(request, admin, resolved, WELCOME_CREDIT_CLAIM_RATE_LIMIT, user.id);
    if (limited) return limited;

    const { data, error } = await admin.rpc('claim_credit_grant_program', {
      p_user_id: user.id,
      p_program_key: WELCOME_CREDIT_PROGRAM_KEY,
      p_source_surface: sourceSurface,
    });
    if (error) throw error;
    const refreshed = await loadWelcomeCreditStatus(admin, user);
    const rpcStatus = data && typeof data === 'object' && 'status' in data
      ? String(data.status)
      : null;
    return privateJson(request, {
      ...refreshed,
      status: rpcStatus === 'claimed' ? 'claimed' : refreshed.status,
    });
  } catch (error) {
    resolved.logError('Welcome credits claim failed:', error);
    return privateJson(request, { error: 'Could not claim welcome credits.', status: 'unavailable' }, 500);
  }
}

export async function postOnboardingEventRouteResponse({
  request,
  dependencies,
}: {
  request: Request;
  dependencies?: Dependencies;
}) {
  const resolved = resolveDependencies(dependencies);
  try {
    const body = await request.json() as Record<string, unknown>;
    if (
      !isValidOnboardingClientEventId(body.clientEventId)
      || !isValidOnboardingInstallationId(body.installationId)
      || !isOnboardingEventName(body.eventName)
      || !['ios', 'android', 'web'].includes(String(body.platform))
      || (body.goal !== undefined && body.goal !== null && !isOnboardingGoal(body.goal))
      || (body.step !== undefined && body.step !== null && (typeof body.step !== 'string' || body.step.length < 1 || body.step.length > 64))
    ) {
      return privateJson(request, { error: 'Invalid onboarding event.' }, 400);
    }

    const admin = resolved.createServiceClient();
    const limited = await rateLimit(request, admin, resolved, ONBOARDING_EVENT_RATE_LIMIT, String(body.installationId));
    if (limited) return limited;
    const user = await authenticate(request, resolved);
    const occurredAt = typeof body.occurredAt === 'string' && Number.isFinite(Date.parse(body.occurredAt))
      ? new Date(body.occurredAt).toISOString()
      : new Date().toISOString();
    const { error } = await admin.from('onboarding_events').upsert({
      client_event_id: body.clientEventId,
      installation_id: body.installationId,
      user_id: user?.id ?? null,
      flow_version: ONBOARDING_FLOW_VERSION,
      variant: ONBOARDING_VARIANT,
      platform: body.platform,
      event_name: body.eventName,
      goal: body.goal ?? null,
      step: body.step ?? null,
      occurred_at: occurredAt,
    }, { onConflict: 'client_event_id', ignoreDuplicates: true });
    if (error) throw error;

    return privateJson(request, { success: true });
  } catch (error) {
    resolved.logError('Onboarding event POST failed:', error);
    return privateJson(request, { error: 'Could not record onboarding event.' }, 500);
  }
}
