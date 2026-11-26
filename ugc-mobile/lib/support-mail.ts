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
