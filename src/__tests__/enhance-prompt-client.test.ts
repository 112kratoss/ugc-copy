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
  PROMPT_ENHANCE_WAIT_HEADER,
  PROMPT_ENHANCE_WAIT_MS,
  requestPromptEnhancement,
} from '@/components/enhancePromptClient';
import {
  PROMPT_ENHANCER_MAX_DEADLINE_MS,
  PROMPT_ENHANCER_WAIT_HEADER,
  resolvePromptEnhancerDeadlineMs,
} from '@/lib/prompt-enhancer';

afterEach(() => {
  vi.unstubAllGlobals();
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
