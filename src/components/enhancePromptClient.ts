'use client';

import type { EnhancerContext, Medium } from '@/lib/prompt-enhancer';
import type {
  PromptEnhancementWarning,
} from '@/lib/prompt-quality';
import { supabase } from '@/lib/supabase';

export interface PromptEnhancementRequest {
  medium: Medium;
  selectedModel: string;
  prompt: string;
  context?: EnhancerContext;
}

export interface PromptEnhancementResult {
  enhancedPrompt: string;
  remainingCredits?: number;
  agentId?: string;
  qualityScore?: number;
  warnings?: PromptEnhancementWarning[];
  appliedSafeguards?: Array<{
    code: string;
    message: string;
  }>;
}

/**
 * This page states the app's wait, and gives an ask up at the end of it, so
 * the enhancer may use its whole budget; a request that states none is held
 * to what an app from before the header can wait (src/lib/prompt-enhancer.ts).
 * Literals: the server module cannot be imported here.
 */
export const PROMPT_ENHANCE_WAIT_HEADER = 'x-magicbooklet-wait-ms';
export const PROMPT_ENHANCE_WAIT_MS = 70_000;

/**
 * A press is one paid request: every ask it makes carries the same key, and the
 * ledger answers a second ask with the answer the first one settled, or says it
 * is still running, instead of charging again. So a lost answer is asked for
 * again: after a dropped connection twice at most, since that fails fast and
 * may be a moment's loss of signal; after an ask that got nothing in the whole
 * wait once, since the server is done with the key by then. A still-running
 * first ask is asked after again until the wait has passed since it was sent,
 * the longest the server works on one key. Each ask spends one of the
 * enhancer's rate-limit allowance (src/lib/backend-rate-limit.ts).
 */
export const PROMPT_ENHANCE_KEY_HEADER = 'Idempotency-Key';
export const PROMPT_ENHANCE_ASK_AGAIN_DELAY_MS = 5_000;
export const PROMPT_ENHANCE_ASKS_AFTER_CONNECTION_FAILURE = 2;
export const PROMPT_ENHANCE_ASKS_AFTER_TIMEOUT = 1;
const STILL_RUNNING_CODE = 'AI_USAGE_IN_PROGRESS';
const LOST_ANSWER_MESSAGE = 'Could not get the enhanced prompt. Check your connection and try again.';

export class PromptEnhancementError extends Error {
  remainingCredits?: number;

  constructor(message: string, options?: { remainingCredits?: number }) {
    super(message);
    this.name = 'PromptEnhancementError';
    this.remainingCredits = options?.remainingCredits;
  }
}

type Ask =
  | { outcome: 'answered'; result: PromptEnhancementResult }
  | { outcome: 'timed-out' | 'connection-failed' }
  | { outcome: 'still-running'; error: PromptEnhancementError };

function createPressKey(): string {
  // randomUUID exists only in a secure context, which a phone on the dev server's LAN address is not.
  const random = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
  return `enhance:${random}`;
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    // A platform error page instead of JSON: its status still says what happened.
    return {};
  }
}

export async function requestPromptEnhancement(request: PromptEnhancementRequest): Promise<PromptEnhancementResult> {
  const key = createPressKey();
  const firstAskAt = Date.now();
  let connectionFailures = 0;
  let timeouts = 0;

  for (;;) {
    const ask = await askOnce(request, key);
    if (ask.outcome === 'answered') return ask.result;
    if (ask.outcome === 'still-running') {
      if (Date.now() - firstAskAt >= PROMPT_ENHANCE_WAIT_MS) throw ask.error;
    } else if (ask.outcome === 'timed-out') {
      if (++timeouts > PROMPT_ENHANCE_ASKS_AFTER_TIMEOUT) throw new PromptEnhancementError(LOST_ANSWER_MESSAGE);
    } else if (++connectionFailures > PROMPT_ENHANCE_ASKS_AFTER_CONNECTION_FAILURE) {
      throw new PromptEnhancementError(LOST_ANSWER_MESSAGE);
    }
    await wait(PROMPT_ENHANCE_ASK_AGAIN_DELAY_MS);
  }
}

async function askOnce(
  { medium, selectedModel, prompt, context }: PromptEnhancementRequest,
  key: string,
): Promise<Ask> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    throw new PromptEnhancementError('Please log in to enhance prompts');
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, PROMPT_ENHANCE_WAIT_MS);
  let response: Response;
  let body: string;
  try {
    response = await fetch('/api/enhance-prompt', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        [PROMPT_ENHANCE_WAIT_HEADER]: String(PROMPT_ENHANCE_WAIT_MS),
        [PROMPT_ENHANCE_KEY_HEADER]: key,
      },
      body: JSON.stringify({ medium, selectedModel, prompt, context }),
      signal: controller.signal,
    });
    // Read whole before parsing: an answer cut off on its way is lost, not malformed.
    body = await response.text();
  } catch {
    return { outcome: timedOut ? 'timed-out' : 'connection-failed' };
  } finally {
    clearTimeout(timeoutId);
  }
  const data = parseJsonObject(body);

  if (!response.ok) {
    const message = response.status === 402
      ? 'Not enough credits (2 required)'
      : typeof data.error === 'string'
        ? data.error
        : 'Enhancement failed';

    const error = new PromptEnhancementError(message, {
      remainingCredits: typeof data.remainingCredits === 'number' ? data.remainingCredits : undefined,
    });
    if (response.status === 409 && data.code === STILL_RUNNING_CODE) {
      return { outcome: 'still-running', error };
    }
    throw error;
  }

  if (typeof data.enhancedPrompt !== 'string' || data.enhancedPrompt.length === 0) {
    throw new PromptEnhancementError('Enhancement failed');
  }

  return {
    outcome: 'answered',
    result: {
      enhancedPrompt: data.enhancedPrompt,
      remainingCredits: typeof data.remainingCredits === 'number' ? data.remainingCredits : undefined,
      agentId: typeof data.agentId === 'string' ? data.agentId : undefined,
      qualityScore: typeof data.qualityScore === 'number' ? data.qualityScore : undefined,
      warnings: Array.isArray(data.warnings)
        ? (data.warnings as unknown[]).filter((warning): warning is PromptEnhancementWarning => (
          typeof warning === 'object'
          && warning !== null
          && typeof (warning as { code?: unknown }).code === 'string'
          && typeof (warning as { severity?: unknown }).severity === 'string'
          && typeof (warning as { message?: unknown }).message === 'string'
        ))
        : undefined,
      appliedSafeguards: Array.isArray(data.appliedSafeguards)
        ? (data.appliedSafeguards as unknown[]).filter((safeguard): safeguard is { code: string; message: string } => (
          typeof safeguard === 'object'
          && safeguard !== null
          && typeof (safeguard as { code?: unknown }).code === 'string'
          && typeof (safeguard as { message?: unknown }).message === 'string'
        ))
        : undefined,
    },
  };
}
