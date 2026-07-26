import { siteConfig } from '@/lib/seo';

export const CHILD_SAFETY_CONTACT_ENV_KEY = 'CHILD_SAFETY_CONTACT_EMAIL';

export type ChildSafetyContact = {
  email: string;
  source: 'configured' | 'support-fallback';
};

const SIMPLE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function resolveChildSafetyContact(
  environment: NodeJS.ProcessEnv = process.env,
): ChildSafetyContact {
  const configuredEmail = environment[CHILD_SAFETY_CONTACT_ENV_KEY]?.trim();

  if (configuredEmail && SIMPLE_EMAIL_PATTERN.test(configuredEmail)) {
    return {
      email: configuredEmail,
      source: 'configured',
    };
  }

  return {
    email: siteConfig.supportEmail,
    source: 'support-fallback',
  };
}
