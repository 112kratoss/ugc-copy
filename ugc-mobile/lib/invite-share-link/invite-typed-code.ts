/**
 * Invite codes a person can say (owner, 2026-11-11: "suppose we can give a
 * unique code instead of the link"), in one copy the app and the web share by
 * relative import.
 *
 * Every invite keeps its link code (twelve hex characters, `/r/<code>`) and has
 * a six-character code the Invite & Earn screens show: digits and capital
 * letters without the look-alikes 0, O, 1 and I, drawn by the database
 * (`new_referral_short_code`, migration 20261111073612). The sign-up pages
 * take what a person types or pastes into "Have an invite code?" and send it
 * as a visit of kind `code`, which replaces any invite held from before.
 *
 * Metro, Next.js and Vitest all compile this file, so it stays free of React
 * Native, Expo and Node imports, and of `URL` (Hermes).
 */

import { normalizeInviteShareCode } from './invite-share-link';

/** The characters a short code is made of (32, so each random byte maps evenly). */
export const INVITE_SHORT_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const INVITE_SHORT_CODE_LENGTH = 6;

const SHORT_CODE_PATTERN = /^[2-9A-HJ-NP-Z]{6}$/;
const INVITE_LINK_PATTERN = /^(?:https?:\/\/)?(?:www\.)?magicbooklet\.com(\/[^\s?#]*)?(\?[^\s#]*)?(?:#\S*)?$/i;

/** A short code as the server issues it, upper-cased, or null. */
export function normalizeInviteShortCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return SHORT_CODE_PATTERN.test(normalized) ? normalized : null;
}

function codeFromInviteLink(text: string): string | null {
  const match = INVITE_LINK_PATTERN.exec(text);
  if (!match) return null;
  const path = match[1] ?? '';
  const pathCode = /^\/r\/([^/]+)\/?$/.exec(path)?.[1];
  if (pathCode) {
    return normalizeInviteShareCode(pathCode) ?? normalizeInviteShortCode(pathCode);
  }
  const query = (match[2] ?? '').replace(/^\?/, '');
  for (const pair of query.split('&')) {
    const [name, value = ''] = pair.split('=');
    if (name === 'r') return normalizeInviteShareCode(value);
  }
  return null;
}

/**
 * The code to send for what someone typed or pasted into "Have an invite
 * code?": a six-character code (any case, with spaces or dashes in it), a link
 * code, or an invite or shared link on magicbooklet.com. Null when it is none
 * of those, including a link to another site.
 */
export function readTypedInviteCode(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  if (/magicbooklet\.com/i.test(trimmed) || trimmed.includes('://')) {
    return codeFromInviteLink(trimmed);
  }
  // Spaces and dashes are how people split a short code when they write it down;
  // a link code is never written that way.
  return normalizeInviteShortCode(trimmed.replace(/[\s-]+/g, '')) ?? normalizeInviteShareCode(trimmed);
}

/**
 * The line an invite message carries its short code in, so a friend who
 * installs the app before opening the link can still type it. Empty without a
 * code (an invite made before its code was read).
 */
export function inviteCodeShareLine(shortCode: unknown): string {
  const code = normalizeInviteShortCode(shortCode);
  return code ? `Invite code: ${code}` : '';
}

/** What the invite-code field says when what was typed cannot be a code. */
export const TYPED_INVITE_CODE_INVALID =
  'Enter the 6-character invite code, or paste the invite link you received.';

/** What it says when no invite has that code (the visit route's 404). */
export const TYPED_INVITE_CODE_NOT_FOUND =
  'That invite code was not found. Check it with whoever invited you.';

/** What it says when the code could not be saved for any other reason. */
export const TYPED_INVITE_CODE_FAILED =
  'Could not save the invite code. Check your connection, then try again.';

/** The field's reminder that an invite is already kept on this device. */
export const TYPED_INVITE_CODE_HELD =
  'An invite is saved on this device. Enter a code to use a different one.';

/** What the sign-up pages say once a typed code is saved. */
export function typedInviteSavedMessage(inviteePercent: number | null | undefined): string {
  const bonus = typeof inviteePercent === 'number' && Number.isFinite(inviteePercent) && inviteePercent > 0
    ? `${Math.round(inviteePercent * 100) / 100}% bonus credits`
    : 'bonus credits';
  return `Invite saved. Create your new account to get ${bonus} on your first top-up. Whoever invited you may earn bonus credits if you join.`;
}
