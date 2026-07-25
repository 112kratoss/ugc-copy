-- Make the email/password sign-up block a permanent product policy.
--
-- `hook_block_password_signups_until_smtp` was introduced as a temporary
-- measure: without SMTP, Supabase Auth cannot send password-reset,
-- confirmation, or email-change mail, so an email/password account has no
-- recovery path and an unverified address cannot be proven to belong to the
-- person who signed up.
--
-- The decision on 2026-07-25 is to stay OAuth-only (Google and Apple) rather
-- than provision SMTP. The hook therefore stops being provisional. Its name is
-- deliberately left alone because the Supabase Auth hook configuration
-- references it by name; only the recorded intent changes.
--
-- Consequence to keep in view: accounts created with the `email` provider
-- BEFORE this hook was installed still exist and still have no self-service
-- password reset. Recovery for those accounts is a manual, staff-run process
-- documented in docs/production-deployment-runbook.md.

COMMENT ON FUNCTION public.hook_block_password_signups_until_smtp(jsonb) IS
  'Permanent identity policy as of 2026-07-25: Magicbooklet is OAuth-only (Google and Apple). Email/password sign-up is rejected because no SMTP sender is configured, so password reset and address confirmation are impossible. Do not remove without first provisioning SMTP and enabling auth.email.enable_confirmations.';
