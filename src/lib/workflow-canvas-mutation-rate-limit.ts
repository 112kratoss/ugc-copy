import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

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

    logBackendError('failed_to_enforce_workflow_canvas_mutation_rate_limit', { error: error });
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
