import {
  TYPED_INVITE_CODE_FAILED,
  TYPED_INVITE_CODE_INVALID,
  TYPED_INVITE_CODE_NOT_FOUND,
  normalizeInviteShortCode,
  readTypedInviteCode,
  typedInviteSavedMessage,
} from '../../ugc-mobile/lib/invite-share-link/invite-typed-code';

export type TypedInviteCodeResult =
  | { ok: true; message: string; shortCode: string | null }
  | { ok: false; message: string };

/**
 * Saves what a visitor typed into the sign-in page's "Have an invite code?"
 * (owner, 2026-11-11): the invite landing's own request, `POST
 * /api/referrals/visit`, marked `kind: 'code'`, which replaces any invite this
 * browser held unless it is the same one, and sets the visit cookie the
 * sign-up's claim reads. It must happen before the account is made: a claim
 * refuses an account older than its visit.
 */
export async function saveTypedInviteCode(
  text: string,
  { fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {},
): Promise<TypedInviteCodeResult> {
  const code = readTypedInviteCode(text);
  if (!code) return { ok: false, message: TYPED_INVITE_CODE_INVALID };

  try {
    const response = await fetchImpl('/api/referrals/visit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, source: 'web', kind: 'code' }),
    });
    const body = await response.json().catch(() => null) as {
      success?: unknown;
      shortCode?: unknown;
      program?: { inviteeFirstPurchasePercent?: unknown } | null;
    } | null;
    if (response.ok && body?.success === true) {
      const percent = body.program?.inviteeFirstPurchasePercent;
      return {
        ok: true,
        message: typedInviteSavedMessage(typeof percent === 'number' ? percent : null),
        shortCode: normalizeInviteShortCode(body.shortCode),
      };
    }
    if (response.status === 404 || response.status === 400) {
      return { ok: false, message: TYPED_INVITE_CODE_NOT_FOUND };
    }
    if (response.status === 429) {
      return { ok: false, message: 'Too many tries. Wait a few minutes, then try again.' };
    }
    return { ok: false, message: TYPED_INVITE_CODE_FAILED };
  } catch {
    return { ok: false, message: TYPED_INVITE_CODE_FAILED };
  }
}
