export class ShowcaseRemixRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ShowcaseRemixRequestError';
    this.status = status;
  }
}

const DEFAULT_REMIX_ERROR = 'Could not start the remix. Please try again.';

/**
 * Starts a remix through POST /api/showcase/remix and returns the create-page
 * redirect. Throws ShowcaseRemixRequestError carrying the server's message so
 * surfaces can show the real reason (rate limited, private source, signed out)
 * instead of silently doing nothing.
 */
export async function requestShowcaseRemix({
  accessToken,
  generationId,
  postId,
  fetchImpl = fetch,
}: {
  accessToken: string;
  generationId?: string;
  postId?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ redirectTo: string }> {
  let response: Response;
  try {
    response = await fetchImpl('/api/showcase/remix', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(postId ? { postId } : { generationId }),
    });
  } catch {
    throw new ShowcaseRemixRequestError('Could not reach the server. Check your connection and try again.', 0);
  }

  const data = await response.json().catch(() => null) as
    | { success?: boolean; redirectTo?: string; error?: string }
    | null;

  if (!response.ok || !data?.success || !data.redirectTo) {
    throw new ShowcaseRemixRequestError(
      (data && typeof data.error === 'string' && data.error) || DEFAULT_REMIX_ERROR,
      response.status,
    );
  }

  return { redirectTo: data.redirectTo };
}
