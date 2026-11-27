import { SUPPORT_EMAIL } from '@/lib/support-conversation-policy/support-conversation-policy';

/**
 * The support mail, with the lines at the foot of Settings below room for the
 * message: which build, update and runtime this phone runs, which support
 * otherwise has to ask for before it can answer. The support chat's "Email us
 * instead" sends it; it moved there from the Help screen when Help & Support
 * began opening the chat itself (owner, 2026-11-26).
 */
export function supportMailUrl(details: ReadonlyArray<string | null>) {
  const lines = details.filter((line): line is string => Boolean(line));
  const body = lines.length > 0 ? `&body=${encodeURIComponent(`\n\n${lines.join('\n')}`)}` : '';
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Magicbooklet app support')}${body}`;
}

/** What the support screen says when no mail app takes the link, and its Copy. */
export const SUPPORT_MAIL_FALLBACK_WORDS = {
  noMailApp: `No mail app opened. Write to us at ${SUPPORT_EMAIL}`,
  copy: 'Copy address',
  copied: 'Address copied',
} as const;

/**
 * Opens the support mail and says whether a mail app took it. A phone with no
 * mail app (or none set up) refuses `mailto:`; the refusal used to be dropped,
 * so the press did nothing (audit 2026-11-27, finding 5). Never rejects.
 */
export async function openSupportMail(
  url: string,
  openURL: (url: string) => Promise<unknown> | unknown,
): Promise<boolean> {
  try {
    await openURL(url);
    return true;
  } catch {
    return false;
  }
}
