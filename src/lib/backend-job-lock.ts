type SupabaseRpcResult = {
  data: unknown;
  error: { message?: string } | Error | null;
};

type SupabaseRpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<SupabaseRpcResult>;
};

export type BackendJobLockOptions = {
  name: string;
  ttlSeconds: number;
  owner: string;
};

export type BackendJobLockResult<T> =
  | { acquired: true; value: T }
  | { acquired: false; reason: 'already_running' };

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

export async function withBackendJobLock<T>(
  client: SupabaseRpcClient,
  options: BackendJobLockOptions,
  task: () => Promise<T>,
): Promise<BackendJobLockResult<T>> {
  if (!options.name.trim()) throw new Error('Backend job lock name is required');
  if (!options.owner.trim()) throw new Error('Backend job lock owner is required');
  if (!Number.isInteger(options.ttlSeconds) || options.ttlSeconds <= 0) {
    throw new Error('Backend job lock TTL must be a positive integer');
  }

  const acquire = await client.rpc('try_acquire_backend_job_lock', {
    p_name: options.name,
    p_ttl_seconds: options.ttlSeconds,
    p_locked_by: options.owner,
  });

  if (acquire.error) throw acquire.error;
  if (acquire.data !== true) {
    return { acquired: false, reason: 'already_running' };
  }

  try {
    return { acquired: true, value: await task() };
  } finally {
    const release = await client.rpc('release_backend_job_lock', {
      p_name: options.name,
      p_locked_by: options.owner,
    });

    if (release.error) {
      console.error(JSON.stringify({
        level: 'error',
        msg: 'backend_job_lock_release_failed',
        job: options.name,
        owner: options.owner,
        error: errorMessage(release.error),
      }));
    }
  }
}
