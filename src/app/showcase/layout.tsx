/**
 * No auth boundary of its own: a layout that read the request's cookies
 * (`RequestHintedOptionalAuth`) made every page under it render per request,
 * the post page included, which is cached for everyone now (`[id]/page.tsx`).
 * Explore keeps its server-checked session in `(feed)/layout.tsx`; the post
 * page checks the session in the browser (`OptionalAuth`).
 */
export default function ShowcaseLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
