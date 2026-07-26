import 'server-only';

type AccountDeletionGuardResult = {
  allowed: boolean;
  status: string | null;
  error: unknown;
};

type AccountDeletionGuardClient = {
  rpc: (
    fn: 'is_account_deletion_requested',
    args: { p_user_id: string },
  ) => PromiseLike<{
    data: unknown;
    error: unknown;
  }>;
};

/**
 * Fail closed when deletion state cannot be checked. Once deletion has been
 * requested, issuing another signed upload URL can recreate data after the
 * cleanup sweep and violate the deletion contract.
 */
export async function canUserCreateDurableUpload(
  client: AccountDeletionGuardClient,
  userId: string,
): Promise<AccountDeletionGuardResult> {
  try {
    const { data, error } = await client.rpc('is_account_deletion_requested', {
      p_user_id: userId,
    });

    if (error || typeof data !== 'boolean') {
      return {
        allowed: false,
        status: null,
        error: error ?? new Error('Account deletion guard returned an invalid response.'),
      };
    }

    return {
      allowed: !data,
      status: data ? 'requested' : null,
      error: null,
    };
  } catch (error) {
    return { allowed: false, status: null, error };
  }
}

export type { AccountDeletionGuardClient };
