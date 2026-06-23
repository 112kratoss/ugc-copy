import 'server-only';

import { NextResponse } from 'next/server';

import {
  BackendRateLimitError,
  WORKFLOW_CANVAS_MUTATION_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { createServiceClient } from '@/lib/server-helpers';

export async function enforceWorkflowCanvasMutationRateLimit(
  userId: string,
  errorMessage: string,
): Promise<NextResponse | null> {
  try {
    await enforceBackendRateLimit(createServiceClient(), {
      ...WORKFLOW_CANVAS_MUTATION_RATE_LIMIT,
      key: userId,
    });
    return null;
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createBackendRateLimitResponse(error);
    }

    console.error('Failed to enforce workflow canvas mutation rate limit:', error);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
