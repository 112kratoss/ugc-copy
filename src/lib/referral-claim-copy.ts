/** The query parameter that carries a sign-up's invite claim to the page that greets it. */
export const REFERRAL_CLAIM_STATUS_PARAM = 'referral';

/** What a claim status may look like: "applied", or the reason `claim_referral_visit` gave. */
export const REFERRAL_CLAIM_REASON_PATTERN = /^[a-z_]{1,64}$/;

/**
 * /auth/continue and /auth/callback put `?referral=` on the page that greets a
 * new account (the welcome-reward page, or the creator a sign-up came back to)
 * when a sign-up claimed an invite: "applied", or why it was refused. The app
 * says the same on its invite screen; a web sign-up otherwise heard nothing.
 */
export function describeReferralClaim(status: string | null) {
  switch (status) {
    case null:
    case '':
      return null;
    case 'applied':
      return 'Invite applied: your first verified credit-pack purchase gets the invite bonus.';
    case 'existing_account':
      return 'Invite not applied: invite bonuses are for new accounts only.';
    case 'self_referral':
      return 'Invite not applied: you cannot use your own invite link.';
    case 'already_attributed':
      return 'Invite not applied: this account already has an inviter.';
    case 'visit_unavailable':
      return 'Invite not applied: this invite link is no longer active. It may have expired or already been used.';
    default:
      return 'Invite not applied: this account is not eligible for this invite.';
  }
}
