import type { PlatformOSType, ShareContent } from 'react-native';

/** A link to send through the system share sheet, and the words that go with it. */
export interface ShareLink {
  /** The share's subject on Android (`EXTRA_SUBJECT`); iOS does not use it. */
  title?: string;
  /** What is said with the link: a post's title, "Nova on Magicbooklet". Never the link itself. */
  text: string;
  url: string;
}

/**
 * What `Share.share` is given for a link, so that every platform sends it once.
 *
 * React Native gives iOS's share sheet `message` and `url` as two separate
 * items, and every destination receives both: a message that already ended in
 * the link sent it twice (Copy pasted "minnal2.0⏎<link> <link>", Reminders
 * listed it twice; owner's report, 2026-11-14). Android sends `message` alone
 * and ignores `url`, so there the link has to be part of the message. Every
 * `Share.share` call in the app takes its content from here
 * (`__tests__/share-sheet-content.test.ts` holds them to it).
 */
export function shareSheetContent(link: ShareLink, os: PlatformOSType): ShareContent {
  const text = link.text.trim();
  const title = link.title ? { title: link.title } : {};
  if (os === 'ios') {
    // An empty message would still reach iOS, as an empty item of its own.
    return text ? { ...title, message: text, url: link.url } : { ...title, url: link.url };
  }
  return { ...title, message: text ? `${text}\n${link.url}` : link.url };
}
