/**
 * No auth boundary of its own: a layout that read the request's cookies
 * (`RequestHintedOptionalAuth`) made every page under it render per request,
 * the storefront included, which is cached for everyone now (`page.tsx`, which
 * checks the session in the browser). Recipe sales keeps its server-checked
 * session in `sell/layout.tsx`; `[assetId]` only redirects.
 */
export default function MarketplaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
