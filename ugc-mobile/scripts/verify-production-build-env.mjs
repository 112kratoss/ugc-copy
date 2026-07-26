#!/usr/bin/env node

const REQUIRED_PRODUCTION_ENV = [
  'EAS_BUILD_GIT_COMMIT_HASH',
  'MAGICBOOKLET_INCLUDE_DEV_CLIENT',
  'EXPO_PUBLIC_SITE_URL',
  'EXPO_PUBLIC_API_BASE_URL',
  'EXPO_PUBLIC_WEB_API_BASE_URL',
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'EXPO_PUBLIC_REVENUECAT_IOS_API_KEY',
  'EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY',
];

const PUBLIC_URL_ENV = [
  'EXPO_PUBLIC_SITE_URL',
  'EXPO_PUBLIC_API_BASE_URL',
  'EXPO_PUBLIC_WEB_API_BASE_URL',
  'EXPO_PUBLIC_SUPABASE_URL',
];

function isPlaceholder(value) {
  return /(?:change[-_ ]?me|example|placeholder|localhost|127\.0\.0\.1|10\.0\.2\.2)/i.test(value);
}

export function validateProductionBuildEnv(env) {
  const errors = [];

  for (const key of REQUIRED_PRODUCTION_ENV) {
    const value = env[key]?.trim();
    if (!value) {
      errors.push(`${key} is required`);
    } else if (isPlaceholder(value)) {
      errors.push(`${key} contains a development or placeholder value`);
    }
  }

  if (
    env.EAS_BUILD_GIT_COMMIT_HASH
    && !/^[0-9a-f]{40}$/i.test(env.EAS_BUILD_GIT_COMMIT_HASH.trim())
  ) {
    errors.push('EAS_BUILD_GIT_COMMIT_HASH must be a full 40-character Git SHA');
  }

  if (
    env.MAGICBOOKLET_INCLUDE_DEV_CLIENT
    && env.MAGICBOOKLET_INCLUDE_DEV_CLIENT.trim() !== 'false'
  ) {
    errors.push('MAGICBOOKLET_INCLUDE_DEV_CLIENT must be exactly false');
  }

  for (const key of PUBLIC_URL_ENV) {
    const value = env[key]?.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') {
        errors.push(`${key} must use HTTPS`);
      }
    } catch {
      errors.push(`${key} must be a valid absolute URL`);
    }
  }

  const publishableKey = env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (publishableKey && publishableKey.length < 20) {
    errors.push('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY is unexpectedly short');
  }

  const iosRevenueCatKey = env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY?.trim();
  if (iosRevenueCatKey && !iosRevenueCatKey.startsWith('appl_')) {
    errors.push('EXPO_PUBLIC_REVENUECAT_IOS_API_KEY must be an iOS public SDK key');
  }

  const androidRevenueCatKey = env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY?.trim();
  if (androidRevenueCatKey && !androidRevenueCatKey.startsWith('goog_')) {
    errors.push('EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY must be an Android public SDK key');
  }

  return errors;
}

function runSelfTest() {
  const valid = {
    EAS_BUILD_GIT_COMMIT_HASH: 'a'.repeat(40),
    MAGICBOOKLET_INCLUDE_DEV_CLIENT: 'false',
    EXPO_PUBLIC_SITE_URL: 'https://magicbooklet.com',
    EXPO_PUBLIC_API_BASE_URL: 'https://magicbooklet.com',
    EXPO_PUBLIC_WEB_API_BASE_URL: 'https://magicbooklet.com',
    EXPO_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_1234567890',
    EXPO_PUBLIC_REVENUECAT_IOS_API_KEY: 'appl_public_key',
    EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY: 'goog_public_key',
  };

  if (validateProductionBuildEnv(valid).length !== 0) {
    throw new Error('valid production environment was rejected');
  }

  const invalidErrors = validateProductionBuildEnv({
    ...valid,
    EAS_BUILD_GIT_COMMIT_HASH: 'short',
    MAGICBOOKLET_INCLUDE_DEV_CLIENT: 'true',
    EXPO_PUBLIC_API_BASE_URL: 'http://localhost:3000',
    EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY: 'appl_wrong_platform',
  });
  const expectedFragments = [
    'full 40-character Git SHA',
    'must be exactly false',
    'development or placeholder value',
    'must use HTTPS',
    'Android public SDK key',
  ];
  for (const fragment of expectedFragments) {
    if (!invalidErrors.some((error) => error.includes(fragment))) {
      throw new Error(`self-test did not reject: ${fragment}`);
    }
  }

  process.stdout.write('Production build environment validator self-test passed.\n');
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
} else if (process.env.EAS_BUILD_PROFILE === 'production') {
  const errors = validateProductionBuildEnv(process.env);
  if (errors.length > 0) {
    process.stderr.write('Production build environment validation failed:\n');
    for (const error of errors) {
      process.stderr.write(`- ${error}\n`);
    }
    process.exitCode = 1;
  } else {
    process.stdout.write('Production build environment validation passed.\n');
  }
} else {
  process.stdout.write('Skipping production environment validation outside the production EAS profile.\n');
}
