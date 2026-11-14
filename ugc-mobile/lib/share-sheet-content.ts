import type { PlatformOSType, ShareContent } from 'react-native';

/** A page to send through the system share sheet: a post or a profile. */
export interface ShareLink {
  /** The page's name: the share's subject on Android, and the line above the link there. */
  title: string;
  /** Android's line above the link, when it is not the name itself ("Nova on Magicbooklet"). */
  text?: string;
  url: string;
}

/** A message that has to arrive whole: an invite, whose offer and referral disclosure travel with its link. */
export interface ShareMessage {
  /** The share's subject on Android. */
  title?: string;
  /** The words, without the link. */
  text: string;
  url: string;
}

/**
 * What `Share.share` is given for a page, so that its link arrives once.
 *
 * iOS gets the link alone. React Native gives iOS's share sheet `message` and
 * `url` as two separate items, and every destination receives both:
 * - with the link in both, it went out twice: Copy pasted
 *   "minnal2.0⏎<link> <link>" (owner's report, 2026-11-14);
 * - with the words alone in `message`, Copy put the words first and the link
 *   second, and anything that reads the pasteboard's text (`UIPasteboard`'s
 *   `string`, its first item) got "minnal2.0" and no link (review of #801,
 *   checked on the simulator).
 * The link alone is one item that every reader gets, and the share sheet,
 * Messages and the chat apps draw the page's own preview, its title and
 * picture, from its Open Graph tags.
 *
 * Android sends `message` alone and ignores `url`, so there the name and the
 * link go in the message, as they always have.
 */
export function shareLinkContent(link: ShareLink, os: PlatformOSType): ShareContent {
  if (os === 'ios') return { url: link.url };
  const words = (link.text ?? link.title).trim();
  return {
    ...(link.title ? { title: link.title } : {}),
    message: words ? `${words}\n${link.url}` : link.url,
  };
}

/**
 * What `Share.share` is given for a message that has to arrive whole: one text
 * with the link once at its end, the same on both platforms. iOS gets no `url`:
 * it would be a second copy of the link (see `shareLinkContent`).
 */
export function shareMessageContent(message: ShareMessage): ShareContent {
  return {
    ...(message.title ? { title: message.title } : {}),
    message: `${message.text.trim()}\n${message.url}`,
  };
}
