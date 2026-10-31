import { afterEach, describe, expect, it, vi } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: 'token-1' } } })),
    },
  },
}));

import {
  PROMPT_ENHANCE_ASK_AGAIN_DELAY_MS,
  PROMPT_ENHANCE_ASKS_AFTER_CONNECTION_FAILURE,
  PROMPT_ENHANCE_ASKS_AFTER_TIMEOUT,
  PROMPT_ENHANCE_KEY_HEADER,
  PROMPT_ENHANCE_WAIT_HEADER,
  PROMPT_ENHANCE_WAIT_MS,
  PromptEnhancementError,
  requestPromptEnhancement,
} from '@/components/enhancePromptClient';
import {
  PROMPT_ENHANCER_MAX_DEADLINE_MS,
  PROMPT_ENHANCER_WAIT_HEADER,
  resolvePromptEnhancerDeadlineMs,
} from '@/lib/prompt-enhancer';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the web page’s enhancement request', () => {
  // The page waits for the answer with no deadline of its own, and a request that
  // states no wait is held to what an app from before the header can wait.
  it('states the app’s wait, so the enhancer may use its whole budget', async () => {
    const sent: { headers: Headers | null } = { headers: null };
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.headers = new Headers(init?.headers);
      return new Response(JSON.stringify({ enhancedPrompt: 'An enhanced poster prompt' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    await expect(requestPromptEnhancement({
      medium: 'image',
      selectedModel: 'nano-banana-pro',
      prompt: 'A poster',
    })).resolves.toMatchObject({ enhancedPrompt: 'An enhanced poster prompt' });

    const { clientWait } = mobileApiContract.endpoints.enhancePrompt;
    expect(PROMPT_ENHANCE_WAIT_HEADER).toBe(PROMPT_ENHANCER_WAIT_HEADER);
    expect(PROMPT_ENHANCE_WAIT_MS).toBe(clientWait.timeoutMs);
    expect(sent.headers?.get(PROMPT_ENHANCER_WAIT_HEADER)).toBe(String(PROMPT_ENHANCE_WAIT_MS));
    expect(resolvePromptEnhancerDeadlineMs(sent.headers!)).toBe(PROMPT_ENHANCER_MAX_DEADLINE_MS);
  });
});

// The ledger keeps a settled answer under the press's key and hands it to a second
// ask, so an answer lost on the way back is fetched again instead of paid for twice.
describe('one press, one key', () => {
  const { askAgain, clientWait, errors } = mobileApiContract.endpoints.enhancePrompt;
  const poster = { medium: 'image' as const, selectedModel: 'nano-banana-pro', prompt: 'A poster' };

  type Ask = { key: string | null; signal: AbortSignal | null };
  type Step = Response | Error | 'hang';

  // Each ask takes the next step: an answer, a dropped connection, or no answer at all.
  function stubAsks(steps: Step[]): Ask[] {
    const asks: Ask[] = [];
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      asks.push({ key: new Headers(init?.headers).get(askAgain.keyHeader), signal: init?.signal ?? null });
      const step = steps.shift() ?? 'hang';
      if (step === 'hang') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      }
      return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
    }));
    return asks;
  }

  const answer = (enhancedPrompt: string) => new Response(JSON.stringify({ enhancedPrompt }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  const refusal = ({ status, response }: { status: number; response: object }) => new Response(JSON.stringify(response), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
  const dropped = () => new TypeError('Failed to fetch');

  it('asks again by the contract’s rule', () => {
    expect(PROMPT_ENHANCE_KEY_HEADER).toBe(askAgain.keyHeader);
    expect(PROMPT_ENHANCE_ASK_AGAIN_DELAY_MS).toBe(askAgain.delayMs);
    expect(PROMPT_ENHANCE_ASKS_AFTER_CONNECTION_FAILURE).toBe(askAgain.afterConnectionFailure);
    expect(PROMPT_ENHANCE_ASKS_AFTER_TIMEOUT).toBe(askAgain.afterTimeout);
  });

  it('sends a key of its own with each press', async () => {
    const asks = stubAsks([answer('One'), answer('Two')]);

    await requestPromptEnhancement(poster);
    await requestPromptEnhancement(poster);

    expect(asks[0].key).toMatch(/\S/);
    expect(asks[1].key).toMatch(/\S/);
    expect(asks[1].key).not.toBe(asks[0].key);
  });

  it('asks again under the same key when the connection drops, twice at most', async () => {
    vi.useFakeTimers();
    const asks = stubAsks([dropped(), dropped(), answer('The answer the first ask paid for')]);

    const pressed = requestPromptEnhancement(poster);
    await vi.advanceTimersByTimeAsync(askAgain.delayMs * askAgain.afterConnectionFailure);

    await expect(pressed).resolves.toMatchObject({ enhancedPrompt: 'The answer the first ask paid for' });
    expect(asks.map((ask) => ask.key)).toEqual(Array(3).fill(asks[0].key));

    // One more drop in a row ends the press, said as a connection fault.
    const lostAsks = stubAsks([dropped(), dropped(), dropped(), answer('Never asked for')]);
    const lost = requestPromptEnhancement(poster).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(askAgain.delayMs * (askAgain.afterConnectionFailure + 1));

    const error = await lost;
    expect(error).toBeInstanceOf(PromptEnhancementError);
    expect((error as Error).message).toMatch(/connection/i);
    expect(lostAsks).toHaveLength(1 + askAgain.afterConnectionFailure);
  });

  it('waits while the first ask is still running, then takes the answer it settled', async () => {
    vi.useFakeTimers();
    const asks = stubAsks([dropped(), refusal(errors.stillRunning), refusal(errors.stillRunning), answer('Settled answer')]);

    const pressed = requestPromptEnhancement(poster);
    await vi.advanceTimersByTimeAsync(askAgain.delayMs * 3);

    await expect(pressed).resolves.toMatchObject({ enhancedPrompt: 'Settled answer' });
    expect(asks).toHaveLength(4);
    expect(new Set(asks.map((ask) => ask.key)).size).toBe(1);
  });

  // The server never works on one key for longer than the wait the ask states.
  it('stops waiting on a running ask once the wait it states has passed since the first', async () => {
    vi.useFakeTimers();
    const asks = stubAsks(Array.from({ length: 40 }, () => refusal(errors.stillRunning)));

    const pressed = requestPromptEnhancement(poster).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(clientWait.timeoutMs + askAgain.delayMs * 2);

    const error = await pressed;
    expect(error).toBeInstanceOf(PromptEnhancementError);
    expect((error as Error).message).toBe(errors.stillRunning.response.error);
    expect(asks).toHaveLength(clientWait.timeoutMs / askAgain.delayMs + 1);
  });

  it('asks once more after an ask that got no answer in the wait it states', async () => {
    vi.useFakeTimers();
    const asks = stubAsks(['hang', answer('Answer to the second ask')]);

    const pressed = requestPromptEnhancement(poster);
    await vi.advanceTimersByTimeAsync(clientWait.timeoutMs - 1);
    expect(asks).toHaveLength(1);
    expect(asks[0].signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1 + askAgain.delayMs);
    expect(asks[0].signal?.aborted).toBe(true);
    await expect(pressed).resolves.toMatchObject({ enhancedPrompt: 'Answer to the second ask' });
    expect(asks[1].key).toBe(asks[0].key);

    // By then the server is done with the key, so a second silence ends the press.
    const silentAsks = stubAsks(['hang', 'hang', answer('Never asked for')]);
    const lost = requestPromptEnhancement(poster).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync((clientWait.timeoutMs + askAgain.delayMs) * 2);

    expect(await lost).toBeInstanceOf(PromptEnhancementError);
    expect(silentAsks).toHaveLength(1 + askAgain.afterTimeout);
  });

  it('reads a refunded first ask as the refund, and asks no more', async () => {
    const asks = stubAsks([refusal(errors.refunded), answer('Never asked for')]);

    const error = await requestPromptEnhancement(poster).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PromptEnhancementError);
    expect((error as Error).message).toBe(errors.refunded.response.error);
    expect(asks).toHaveLength(1);
  });
});
