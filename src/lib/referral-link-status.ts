/**
 * The error code the referral link route answers a switched-off link with
 * (409): an operator switched the account's link off in `/admin/referrals`.
 * Clients read it as a state ("no invite to carry"), never as an outage.
 * #754's shared share-link rules re-export the same value for the app.
 */
export const REFERRAL_LINK_DISABLED_CODE = 'REFERRAL_LINK_DISABLED';
