import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  POST_MUTATION_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  preparePostCreationSubmission,
  type PostCreationSubmissionResult,
} from '@/lib/post-creation-submission-service';
import {
  publishPreparedPost,
  type PostPublishResult,
} from '@/lib/post-publish-service';
import {
  listSourceToolsCatalog,
} from '@/lib/source-tools-server';
import type { SourceToolOption } from '@/lib/source-tools';

type CreateOwnerPostDependencies = {
  listSourceToolsCatalog?: () => Promise<SourceToolOption[]>;
  preparePostCreationSubmission?: typeof preparePostCreationSubmission;
  publishPreparedPost?: typeof publishPreparedPost;
};

type PostCreationSubmissionFailure = Extract<PostCreationSubmissionResult, { ok: false }>;

type CreateOwnerPostRouteResult =
  | PostPublishResult
  | PostCreationSubmissionFailure
  | {
      ok: false;
      status: 429 | 500;
      body: {
        error: string;
        code?: 'RATE_LIMITED';
        retryAfterSeconds?: number;
        limit?: number;
        resetAt?: string;
      };
      rateLimitError?: BackendRateLimitError;
    };

function resolveDependencies(dependencies: CreateOwnerPostDependencies | undefined) {
  return {
    listSourceToolsCatalog: dependencies?.listSourceToolsCatalog ?? listSourceToolsCatalog,
    preparePostCreationSubmission: dependencies?.preparePostCreationSubmission ?? preparePostCreationSubmission,
    publishPreparedPost: dependencies?.publishPreparedPost ?? publishPreparedPost,
  };
}

function createRateLimitResult(error: BackendRateLimitError): CreateOwnerPostRouteResult {
  return {
    ok: false,
    status: 429,
    rateLimitError: error,
    body: {
      error: error.message,
      code: 'RATE_LIMITED',
      retryAfterSeconds: error.retryAfterSeconds,
      limit: error.state.limit,
      resetAt: error.state.resetAt,
    },
  };
}

export async function createOwnerPostForRoute({
  adminSupabase,
  ownerUserId,
  readFormData,
  createPostId = randomUUID,
  dependencies,
}: {
  adminSupabase: SupabaseClient;
  ownerUserId: string;
  readFormData: () => Promise<FormData>;
  createPostId?: () => string;
  dependencies?: CreateOwnerPostDependencies;
}): Promise<CreateOwnerPostRouteResult> {
  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...POST_MUTATION_RATE_LIMIT,
      key: ownerUserId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createRateLimitResult(error);
    }

    logBackendError('failed_to_enforce_post_creation_rate_limit', { error: error });
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to create post.' },
    };
  }

  const resolvedDependencies = resolveDependencies(dependencies);
  const formData = await readFormData();
  const sourceToolCatalog = await resolvedDependencies.listSourceToolsCatalog();
  const preparedSubmission = await resolvedDependencies.preparePostCreationSubmission({
    formData,
    userId: ownerUserId,
    sourceToolCatalog,
  });
  if (!preparedSubmission.ok) {
    return preparedSubmission;
  }

  return resolvedDependencies.publishPreparedPost({
    adminSupabase,
    ownerUserId,
    postId: createPostId(),
    submission: preparedSubmission.submission,
  });
}
