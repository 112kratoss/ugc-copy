'use client';

import type { EnhancerContext, Medium } from '@/lib/prompt-enhancer';
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
}

export class PromptEnhancementError extends Error {
  remainingCredits?: number;

  constructor(message: string, options?: { remainingCredits?: number }) {
    super(message);
    this.name = 'PromptEnhancementError';
    this.remainingCredits = options?.remainingCredits;
  }
}

export async function requestPromptEnhancement({
  medium,
  selectedModel,
  prompt,
  context,
}: PromptEnhancementRequest): Promise<PromptEnhancementResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    throw new PromptEnhancementError('Please log in to enhance prompts');
  }

  const response = await fetch('/api/enhance-prompt', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ medium, selectedModel, prompt, context }),
  });

  const data = await response.json().catch(() => ({} as Record<string, unknown>));

  if (!response.ok) {
    const message = response.status === 402
      ? 'Not enough credits (2 required)'
      : typeof data.error === 'string'
        ? data.error
        : 'Enhancement failed';

    throw new PromptEnhancementError(message, {
      remainingCredits: typeof data.remainingCredits === 'number' ? data.remainingCredits : undefined,
    });
  }

  if (typeof data.enhancedPrompt !== 'string' || data.enhancedPrompt.length === 0) {
    throw new PromptEnhancementError('Enhancement failed');
  }

  return {
    enhancedPrompt: data.enhancedPrompt,
    remainingCredits: typeof data.remainingCredits === 'number' ? data.remainingCredits : undefined,
  };
}
