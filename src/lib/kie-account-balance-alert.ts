import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  hasConfiguredBackendAlertDelivery,
  postBackendAlertEvent,
  shouldNotifyBackendAlertOk,
  type BackendAlertEventBody,
  type BackendAlertEventSeverity,
} from '@/lib/backend-alert-transport';
import type { BackendJobName } from '@/lib/backend-jobs';
import { logBackendEvent } from '@/lib/backend-logger';
import {
  KieAccountBalanceError,
  readKieAccountBalance,
  type KieAccountBalance,
  type KieAccountBalanceErrorReason,
} from '@/lib/kie-account-balance';

/**
 * The operator alert for the Kie.ai prepaid credit balance.
 *
 * Every check reads the balance and compares it with the alert threshold
 * (`KIE_BALANCE_ALERT_CREDITS`, default 2000). An episode opens the first time
 * the balance is seen below it (`low`) and closes once a reading is back at
 * the recovery level, 10% above it, so a refund of a few credits near the line
 * cannot flap the alert. A generation refused for insufficient credits puts
 * the episode at `exhausted`, whatever the reading.
 *
 * The operator hears of it two ways:
 *  - pulled: while an episode is open, `/api/ops/backend-alerts` carries a
 *    degraded `KIE_BALANCE_LOW` / `KIE_BALANCE_EXHAUSTED` alert and answers
 *    503, so the hourly backend-alert-watchdog workflow fails and GitHub mails
 *    the owner until the account is topped up (backend-alerts.ts);
 *  - pushed, when `BACKEND_ALERT_DELIVERY_URL` is set: one `backend_alerts`
 *    envelope per change of episode (opened, escalated to exhausted, and
 *    closed, the last only with `BACKEND_ALERT_DELIVERY_NOTIFY_OK=true`), all
 *    under one dedupe key per episode. The ten-minute summary push leaves the
 *    balance out, so it is never re-sent on every tick.
 *
 * The state is the job's own run summary in `backend_job_runs`. A check reads
 * the newest one under the job lock and writes its own onto its run row before
 * the lock is released, so the check that takes the lock next (the scheduled
 * poll or a refusal check) always reads it.
 *
 * Deliberately not a backend health issue: the release gate requires health to
 * be strictly ok, and a balance waiting on a top-up must not block a release.
 */

export const KIE_ACCOUNT_BALANCE_JOB_NAME = 'kie-account-balance' satisfies BackendJobName;
export const KIE_BALANCE_ALERT_CREDITS_ENV = 'KIE_BALANCE_ALERT_CREDITS';
export const DEFAULT_KIE_BALANCE_ALERT_CREDITS = 2000;
/** The episode closes at the threshold plus this share of it. */
export const KIE_BALANCE_RECOVERY_MARGIN = 0.1;
/**
 * A failed read (Kie rate-limits the whole account, and its API has bad
 * minutes) or a failed alert post is retried by the next check. Only this many
 * in a row fail the job's run, which backend health then reports.
 */
export const KIE_BALANCE_CHECK_FAILURE_LIMIT = 3;

const SUMMARY_KIND = 'kie-account-balance';
const SUMMARY_VERSION = 1;
/** Newest rows read to find the latest summary; skipped runs carry none. */
const STATE_SCAN_LIMIT = 20;
const RUNBOOK_PATH = 'docs/production-deployment-runbook.md#alert-response-guide';
const MONITOR_ENDPOINTS = ['/api/ops/backend-alerts', '/api/ops/backend-dashboard'];
const MAX_DELIVERY_ERROR_LENGTH = 200;

export type KieBalanceAlertPolicy = {
  thresholdCredits: number;
  recoveryCredits: number;
  source: 'default' | 'env' | 'invalid_env';
};

export type KieBalanceAlertLevel = 'ok' | 'low' | 'exhausted';
export type KieBalanceCheckTrigger = 'schedule' | 'provider-refusal';
export type KieBalanceAlertTransition = 'raised' | 'escalated' | 'resolved' | 'none';

export type KieBalanceRead =
  | { ok: true; credits: number }
  | {
      ok: false;
      reason: KieAccountBalanceErrorReason;
      httpStatus?: number;
      providerCode?: number;
    };

export type KieBalanceObservation = {
  credits: number;
  observedAt: string;
};

export type KieBalanceAlertDelivery = {
  configured: boolean;
  delivered: boolean;
  severity: BackendAlertEventSeverity;
  dedupeKey: string;
  reason?: 'not_configured' | 'notify_ok_disabled' | 'failed';
  destinationHost?: string;
  responseStatus?: number;
  error?: string;
};

/** What one check saw, decided and told. Stored as the job run's summary. */
export type KieBalanceCheckSummary = {
  kind: typeof SUMMARY_KIND;
  version: typeof SUMMARY_VERSION;
  checkedAt: string;
  trigger: KieBalanceCheckTrigger;
  thresholdCredits: number;
  recoveryCredits: number;
  thresholdSource: KieBalanceAlertPolicy['source'];
  read: KieBalanceRead;
  /** The newest successful read, carried forward across failed ones. */
  lastObservation: KieBalanceObservation | null;
  /** Where the evidence puts the balance; what the alerts endpoint and the dashboard report. */
  episodeLevel: KieBalanceAlertLevel;
  /** What the alert push has told (or recorded, with no destination); behind `episodeLevel` while a post is failing. */
  notifiedLevel: KieBalanceAlertLevel;
  /** When the open episode began: its dedupe key, from the first raise through the recovery. */
  episodeStartedAt: string | null;
  /** What this check pushed, comparing `notifiedLevel` before it with `episodeLevel`. */
  transition: KieBalanceAlertTransition;
  delivery: KieBalanceAlertDelivery | null;
  /** Checks in a row whose read or alert post failed. */
  consecutiveFailures: number;
};

export class KieAccountBalanceCheckError extends Error {
  readonly summary: KieBalanceCheckSummary;

  constructor(summary: KieBalanceCheckSummary) {
    const lastFailure = summary.read.ok ? 'alert delivery failed' : `read ${summary.read.reason}`;
    super(`Kie account balance check failed ${summary.consecutiveFailures} checks in a row (${lastFailure}).`);
    this.name = 'KieAccountBalanceCheckError';
    this.summary = summary;
  }
}

const LEVEL_RANK: Record<KieBalanceAlertLevel, number> = { ok: 0, low: 1, exhausted: 2 };

function higherLevel(left: KieBalanceAlertLevel, right: KieBalanceAlertLevel): KieBalanceAlertLevel {
  return LEVEL_RANK[right] > LEVEL_RANK[left] ? right : left;
}

function roundCredits(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatCredits(value: number): string {
  return String(roundCredits(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return String(error);
}

export function resolveKieBalanceAlertPolicy(
  environment: NodeJS.ProcessEnv = process.env,
): KieBalanceAlertPolicy {
  const configured = environment[KIE_BALANCE_ALERT_CREDITS_ENV]?.trim();
  let thresholdCredits = DEFAULT_KIE_BALANCE_ALERT_CREDITS;
  let source: KieBalanceAlertPolicy['source'] = 'default';

  if (configured) {
    const parsed = Number(configured);
    if (Number.isFinite(parsed) && parsed > 0) {
      thresholdCredits = parsed;
      source = 'env';
    } else {
      source = 'invalid_env';
    }
  }

  return {
    thresholdCredits,
    recoveryCredits: roundCredits(thresholdCredits * (1 + KIE_BALANCE_RECOVERY_MARGIN)),
    source,
  };
}

function isLevel(value: unknown): value is KieBalanceAlertLevel {
  return value === 'ok' || value === 'low' || value === 'exhausted';
}

function parseObservation(value: unknown): KieBalanceObservation | null {
  if (!isRecord(value)) return null;
  return typeof value.credits === 'number' && Number.isFinite(value.credits)
    && typeof value.observedAt === 'string'
    ? { credits: value.credits, observedAt: value.observedAt }
    : null;
}

/** A stored summary this job wrote, or null for anything else (a skipped run's note, another shape). */
export function parseKieBalanceCheckSummary(value: unknown): KieBalanceCheckSummary | null {
  if (!isRecord(value) || value.kind !== SUMMARY_KIND || value.version !== SUMMARY_VERSION) return null;
  if (
    !isLevel(value.episodeLevel)
    || !isLevel(value.notifiedLevel)
    || typeof value.checkedAt !== 'string'
    || !isRecord(value.read)
  ) {
    return null;
  }

  const consecutiveFailures = typeof value.consecutiveFailures === 'number'
    && Number.isInteger(value.consecutiveFailures) && value.consecutiveFailures > 0
    ? value.consecutiveFailures
    : 0;

  return {
    ...(value as KieBalanceCheckSummary),
    lastObservation: parseObservation(value.lastObservation),
    episodeLevel: value.episodeLevel,
    notifiedLevel: value.notifiedLevel,
    episodeStartedAt: typeof value.episodeStartedAt === 'string' ? value.episodeStartedAt : null,
    consecutiveFailures,
  };
}

/** The newest summary this job stored, or null before its first check. */
export async function loadLatestKieBalanceCheck(
  client: SupabaseClient,
): Promise<KieBalanceCheckSummary | null> {
  const { data, error } = await client
    .from('backend_job_runs')
    .select('summary,started_at')
    .eq('job_name', KIE_ACCOUNT_BALANCE_JOB_NAME)
    .not('summary', 'is', null)
    .order('started_at', { ascending: false })
    .limit(STATE_SCAN_LIMIT);

  if (error) throw new Error(errorMessage(error));

  for (const row of (data ?? []) as Array<{ summary?: unknown }>) {
    const summary = parseKieBalanceCheckSummary(row.summary);
    if (summary) return summary;
  }
  return null;
}

function describeReadFailure(error: unknown): Extract<KieBalanceRead, { ok: false }> {
  if (error instanceof KieAccountBalanceError) {
    return {
      ok: false,
      reason: error.reason,
      ...(error.httpStatus === null ? {} : { httpStatus: error.httpStatus }),
      ...(error.providerCode === null ? {} : { providerCode: error.providerCode }),
    };
  }
  return { ok: false, reason: 'network_error' };
}

/** Where the evidence of this check puts the episode. */
function decideEpisodeLevel({
  previousLevel,
  credits,
  providerRefusal,
  policy,
}: {
  previousLevel: KieBalanceAlertLevel;
  credits: number | null;
  providerRefusal: boolean;
  policy: KieBalanceAlertPolicy;
}): KieBalanceAlertLevel {
  // Kie refusing a generation for credits is the strongest evidence there is,
  // whatever the balance read says or whether it could be made at all.
  if (providerRefusal) return 'exhausted';
  if (credits !== null && credits >= policy.recoveryCredits) return 'ok';
  if (credits !== null && credits < policy.thresholdCredits) return higherLevel(previousLevel, 'low');
  // No reading, or one between the threshold and the recovery level: nothing changes.
  return previousLevel;
}

function decideTransition(
  notifiedLevel: KieBalanceAlertLevel,
  episodeLevel: KieBalanceAlertLevel,
): KieBalanceAlertTransition {
  if (LEVEL_RANK[episodeLevel] > LEVEL_RANK[notifiedLevel]) {
    return notifiedLevel === 'ok' ? 'raised' : 'escalated';
  }
  if (episodeLevel === 'ok' && notifiedLevel !== 'ok') return 'resolved';
  return 'none';
}

function describeBalance(
  read: KieBalanceRead,
  lastObservation: KieBalanceObservation | null,
): string {
  if (read.ok) return `${formatCredits(read.credits)} credits`;
  const last = lastObservation
    ? `the last reading was ${formatCredits(lastObservation.credits)} credits at ${lastObservation.observedAt}`
    : 'no earlier reading exists';
  return `an unknown balance (it could not be read: ${read.reason}; ${last})`;
}

/** The alert for an open episode: one code and message for both the pushed event and `/api/ops/backend-alerts`. */
export function describeKieBalanceAlert({
  level,
  balance,
  thresholdCredits,
  recoveryCredits,
}: {
  level: Exclude<KieBalanceAlertLevel, 'ok'>;
  balance: string;
  thresholdCredits: number;
  recoveryCredits: number;
}): { code: 'KIE_BALANCE_LOW' | 'KIE_BALANCE_EXHAUSTED'; message: string } {
  const clears = `Top up the Kie.ai account to at least ${formatCredits(recoveryCredits)} credits to clear this.`;
  if (level === 'exhausted') {
    return {
      code: 'KIE_BALANCE_EXHAUSTED',
      message: `Kie.ai refused a generation for insufficient credits, so every start is refunded and creators are told the provider is unavailable. Balance: ${balance}. ${clears}`,
    };
  }
  return {
    code: 'KIE_BALANCE_LOW',
    message: `The Kie.ai credit balance is ${balance}, below the ${formatCredits(thresholdCredits)}-credit alert threshold; every generation is paid from it. ${clears}`,
  };
}

function buildAlertEvent({
  checkedAt,
  dedupeKey,
  episodeLevel,
  lastObservation,
  policy,
  read,
  trigger,
}: {
  checkedAt: string;
  dedupeKey: string;
  episodeLevel: KieBalanceAlertLevel;
  lastObservation: KieBalanceObservation | null;
  policy: KieBalanceAlertPolicy;
  read: KieBalanceRead;
  trigger: KieBalanceCheckTrigger;
}): BackendAlertEventBody {
  const balance = describeBalance(read, lastObservation);
  const signals = {
    kieBalanceCredits: lastObservation?.credits ?? null,
    kieBalanceObservedAt: lastObservation?.observedAt ?? null,
    kieBalanceThresholdCredits: policy.thresholdCredits,
    kieBalanceRecoveryCredits: policy.recoveryCredits,
    kieBalanceLevel: episodeLevel,
    trigger,
  };

  if (episodeLevel === 'ok') {
    return {
      event: 'backend_alerts',
      source: 'magicbooklet-backend',
      status: 'ok',
      checkedAt,
      delivery: {
        severity: 'ok',
        title: `Kie.ai credits recovered: ${balance} left`,
        summary: `The Kie.ai credit balance is back to ${balance}, at or above the ${formatCredits(policy.recoveryCredits)}-credit recovery level.`,
        dedupeKey,
        runbookPath: RUNBOOK_PATH,
        monitorEndpoints: MONITOR_ENDPOINTS,
      },
      signals,
      counts: { total: 0, degraded: 0, warning: 0 },
      monitorEndpoints: MONITOR_ENDPOINTS,
      alerts: [],
    };
  }

  const alert = describeKieBalanceAlert({
    level: episodeLevel,
    balance,
    thresholdCredits: policy.thresholdCredits,
    recoveryCredits: policy.recoveryCredits,
  });
  return {
    event: 'backend_alerts',
    source: 'magicbooklet-backend',
    status: 'degraded',
    checkedAt,
    delivery: {
      severity: 'degraded',
      title: episodeLevel === 'exhausted'
        ? 'Kie.ai credits exhausted: generations are failing'
        : `Kie.ai credits low: ${balance} left`,
      summary: `${alert.code}: ${alert.message}`,
      dedupeKey,
      runbookPath: RUNBOOK_PATH,
      monitorEndpoints: MONITOR_ENDPOINTS,
    },
    signals,
    counts: { total: 1, degraded: 1, warning: 0 },
    monitorEndpoints: MONITOR_ENDPOINTS,
    alerts: [{ source: 'kie-balance', severity: 'degraded', code: alert.code, message: alert.message }],
  };
}

async function deliverAlertEvent(
  event: BackendAlertEventBody,
  options: { environment: NodeJS.ProcessEnv; fetcher?: typeof fetch },
): Promise<KieBalanceAlertDelivery> {
  const base = { severity: event.delivery.severity, dedupeKey: event.delivery.dedupeKey };

  if (!hasConfiguredBackendAlertDelivery(options.environment)) {
    return { ...base, configured: false, delivered: false, reason: 'not_configured' };
  }
  if (event.status === 'ok' && !shouldNotifyBackendAlertOk(options.environment)) {
    return { ...base, configured: true, delivered: false, reason: 'notify_ok_disabled' };
  }

  try {
    const receipt = await postBackendAlertEvent(event, options);
    return {
      ...base,
      configured: true,
      delivered: true,
      destinationHost: receipt.destinationHost,
      responseStatus: receipt.responseStatus,
    };
  } catch (error) {
    return {
      ...base,
      configured: true,
      delivered: false,
      reason: 'failed',
      error: errorMessage(error).slice(0, MAX_DELIVERY_ERROR_LENGTH),
    };
  }
}

/**
 * Writes the summary onto this check's own run row while the job lock is still
 * held. The run's finish writes it again; this copy is what a check taking the
 * lock in the moment between the two reads.
 */
async function recordOnOwnRun(
  client: SupabaseClient,
  lockOwner: string,
  summary: KieBalanceCheckSummary,
): Promise<void> {
  try {
    const { error } = await client
      .from('backend_job_runs')
      .update({ summary })
      .eq('job_name', KIE_ACCOUNT_BALANCE_JOB_NAME)
      .eq('lock_owner', lockOwner);
    if (error) {
      logBackendEvent('warn', 'kie_balance_state_write_failed', { error: errorMessage(error) });
    }
  } catch (error) {
    logBackendEvent('warn', 'kie_balance_state_write_failed', { error: errorMessage(error) });
  }
}

function logCheck(summary: KieBalanceCheckSummary): void {
  const credits = summary.lastObservation?.credits ?? null;
  const delivery = summary.delivery;

  if (!summary.read.ok) {
    logBackendEvent('warn', 'kie_balance_read_failed', {
      trigger: summary.trigger,
      reason: summary.read.reason,
      httpStatus: summary.read.httpStatus,
      providerCode: summary.read.providerCode,
      consecutiveFailures: summary.consecutiveFailures,
    });
  }

  if (summary.transition === 'raised' || summary.transition === 'escalated') {
    logBackendEvent('error', 'kie_balance_alert_raised', {
      trigger: summary.trigger,
      transition: summary.transition,
      episodeLevel: summary.episodeLevel,
      credits,
      thresholdCredits: summary.thresholdCredits,
      delivered: delivery?.delivered ?? false,
      deliveryReason: delivery?.reason,
      dedupeKey: delivery?.dedupeKey,
    });
  } else if (summary.transition === 'resolved') {
    logBackendEvent('info', 'kie_balance_alert_resolved', {
      trigger: summary.trigger,
      credits,
      recoveryCredits: summary.recoveryCredits,
      delivered: delivery?.delivered ?? false,
      deliveryReason: delivery?.reason,
      dedupeKey: delivery?.dedupeKey,
    });
  }

  if (delivery?.reason === 'failed') {
    logBackendEvent('warn', 'kie_balance_alert_delivery_failed', {
      trigger: summary.trigger,
      transition: summary.transition,
      dedupeKey: delivery.dedupeKey,
      error: delivery.error,
      consecutiveFailures: summary.consecutiveFailures,
    });
  }
}

/**
 * One balance check. The caller holds the `kie-account-balance` job lock and
 * has a run row under `lockOwner` (see `runKieAccountBalanceBackendJob` and
 * `runKieRefusalBalanceCheck`). Throws `KieAccountBalanceCheckError`, carrying
 * the summary, once `KIE_BALANCE_CHECK_FAILURE_LIMIT` checks in a row have
 * failed; any other throw is the state read failing, before Kie is asked.
 */
export async function checkKieAccountBalance(
  client: SupabaseClient,
  options: {
    trigger: KieBalanceCheckTrigger;
    lockOwner: string;
    now?: Date;
    environment?: NodeJS.ProcessEnv;
    fetcher?: typeof fetch;
    readBalance?: () => Promise<KieAccountBalance>;
  },
): Promise<KieBalanceCheckSummary> {
  const now = options.now ?? new Date();
  const checkedAt = now.toISOString();
  const environment = options.environment ?? process.env;
  const policy = resolveKieBalanceAlertPolicy(environment);
  if (policy.source === 'invalid_env') {
    logBackendEvent('warn', 'kie_balance_alert_threshold_invalid', {
      variable: KIE_BALANCE_ALERT_CREDITS_ENV,
      thresholdCredits: policy.thresholdCredits,
    });
  }
  const previous = await loadLatestKieBalanceCheck(client);
  const previousNotifiedLevel = previous?.notifiedLevel ?? 'ok';

  let read: KieBalanceRead;
  try {
    const balance = await (options.readBalance ?? (() => readKieAccountBalance({
      environment,
      fetcher: options.fetcher,
      now: () => now,
    })))();
    read = { ok: true, credits: balance.credits };
  } catch (error) {
    read = describeReadFailure(error);
  }

  const lastObservation = read.ok
    ? { credits: read.credits, observedAt: checkedAt }
    : previous?.lastObservation ?? null;
  const episodeLevel = decideEpisodeLevel({
    previousLevel: previous?.episodeLevel ?? 'ok',
    credits: read.ok ? read.credits : null,
    providerRefusal: options.trigger === 'provider-refusal',
    policy,
  });
  const transition = decideTransition(previousNotifiedLevel, episodeLevel);

  // One key for everything an episode sends, kept until its recovery is told.
  let episodeStartedAt = episodeLevel === 'ok' && previousNotifiedLevel === 'ok'
    ? null
    : previous?.episodeStartedAt ?? checkedAt;
  let notifiedLevel = previousNotifiedLevel;
  let delivery: KieBalanceAlertDelivery | null = null;

  if (transition !== 'none') {
    delivery = await deliverAlertEvent(buildAlertEvent({
      checkedAt,
      dedupeKey: `${KIE_ACCOUNT_BALANCE_JOB_NAME}:${episodeStartedAt ?? checkedAt}`,
      episodeLevel,
      lastObservation,
      policy,
      read,
      trigger: options.trigger,
    }), { environment, fetcher: options.fetcher });

    // A failed post leaves the level untold, so the next check sends it again.
    if (delivery.reason !== 'failed') notifiedLevel = episodeLevel;
  }
  if (episodeLevel === 'ok' && notifiedLevel === 'ok') episodeStartedAt = null;

  const failed = !read.ok || delivery?.reason === 'failed';
  const summary: KieBalanceCheckSummary = {
    kind: SUMMARY_KIND,
    version: SUMMARY_VERSION,
    checkedAt,
    trigger: options.trigger,
    thresholdCredits: policy.thresholdCredits,
    recoveryCredits: policy.recoveryCredits,
    thresholdSource: policy.source,
    read,
    lastObservation,
    episodeLevel,
    notifiedLevel,
    episodeStartedAt,
    transition,
    delivery,
    consecutiveFailures: failed ? (previous?.consecutiveFailures ?? 0) + 1 : 0,
  };

  await recordOnOwnRun(client, options.lockOwner, summary);
  logCheck(summary);

  if (summary.consecutiveFailures >= KIE_BALANCE_CHECK_FAILURE_LIMIT) {
    throw new KieAccountBalanceCheckError(summary);
  }
  return summary;
}

/** The last reading and the open episode, for the alerts endpoint and the ops dashboard. */
export type KieBalanceStatus = {
  available: boolean;
  error: string | null;
  thresholdCredits: number;
  recoveryCredits: number;
  episodeLevel: KieBalanceAlertLevel;
  credits: number | null;
  observedAt: string | null;
  lastCheckedAt: string | null;
  lastCheckError: KieAccountBalanceErrorReason | 'alert_delivery_failed' | null;
  consecutiveFailures: number;
  episodeStartedAt: string | null;
};

/** Reads the job's last summary, never Kie. Never throws: an unreadable state is reported as unavailable. */
export async function collectKieBalanceStatus(
  client: SupabaseClient,
  options: { environment?: NodeJS.ProcessEnv } = {},
): Promise<KieBalanceStatus> {
  const policy = resolveKieBalanceAlertPolicy(options.environment ?? process.env);
  const empty: KieBalanceStatus = {
    available: true,
    error: null,
    thresholdCredits: policy.thresholdCredits,
    recoveryCredits: policy.recoveryCredits,
    episodeLevel: 'ok',
    credits: null,
    observedAt: null,
    lastCheckedAt: null,
    lastCheckError: null,
    consecutiveFailures: 0,
    episodeStartedAt: null,
  };

  let latest: KieBalanceCheckSummary | null;
  try {
    latest = await loadLatestKieBalanceCheck(client);
  } catch (error) {
    return { ...empty, available: false, error: errorMessage(error) };
  }
  if (!latest) return empty;

  return {
    available: true,
    error: null,
    thresholdCredits: latest.thresholdCredits,
    recoveryCredits: latest.recoveryCredits,
    episodeLevel: latest.episodeLevel,
    credits: latest.lastObservation?.credits ?? null,
    observedAt: latest.lastObservation?.observedAt ?? null,
    lastCheckedAt: latest.checkedAt,
    lastCheckError: !latest.read.ok
      ? latest.read.reason
      : latest.delivery?.reason === 'failed' ? 'alert_delivery_failed' : null,
    consecutiveFailures: latest.consecutiveFailures,
    episodeStartedAt: latest.episodeStartedAt,
  };
}

/** The open episode as a backend alert for `/api/ops/backend-alerts`, or null when none is open. */
export function kieBalanceAlertFromStatus(
  status: KieBalanceStatus,
): { code: 'KIE_BALANCE_LOW' | 'KIE_BALANCE_EXHAUSTED'; message: string } | null {
  if (!status.available || status.episodeLevel === 'ok') return null;
  const balance = status.credits === null
    ? 'unknown (no successful reading yet)'
    : `${formatCredits(status.credits)} credits at ${status.observedAt ?? 'an unknown time'}`;
  return describeKieBalanceAlert({
    level: status.episodeLevel,
    balance,
    thresholdCredits: status.thresholdCredits,
    recoveryCredits: status.recoveryCredits,
  });
}

/** One line for the dashboard panel. */
export function describeKieBalanceStatus(status: KieBalanceStatus): string {
  if (!status.available) return `The balance state could not be read: ${status.error ?? 'unknown error'}.`;
  if (status.credits === null && status.lastCheckedAt === null) return 'No balance check recorded yet.';

  const balance = status.credits === null ? 'an unknown balance' : `${formatCredits(status.credits)} credits`;
  const failing = status.consecutiveFailures > 0
    ? ` The last ${status.consecutiveFailures} check(s) failed (${status.lastCheckError ?? 'unknown'}).`
    : '';

  if (status.episodeLevel === 'exhausted') {
    return `Kie refused a generation for insufficient credits; last reading ${balance}. Top up the Kie.ai account.${failing}`;
  }
  if (status.episodeLevel === 'low') {
    return `${balance} left, below the ${formatCredits(status.thresholdCredits)}-credit alert threshold.${failing}`;
  }
  return `${balance} left.${failing}`;
}
