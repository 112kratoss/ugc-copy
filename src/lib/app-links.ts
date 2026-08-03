import universalLinksV1 from '../../contracts/universal-links-v1.json';

/**
 * The paths a shared magicbooklet.com link opens in the native app instead of a
 * browser.
 *
 * iOS reads this list out of the AASA document, and Android matches on
 * `pathPrefix` entries in `ugc-mobile/app.json`. They are the same fact stated
 * in two workspaces that never import each other, so the contract file is the
 * single source and both sides are asserted against it.
 */
export const UNIVERSAL_LINK_PATHS = universalLinksV1.paths as readonly string[];
