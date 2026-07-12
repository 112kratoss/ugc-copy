import { NextResponse } from 'next/server';

export const dynamic = 'force-static';

function fingerprints() {
  return (process.env.ANDROID_APP_SHA256_FINGERPRINTS ?? '')
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter((value) => /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value));
}

export function GET() {
  const packageName = process.env.ANDROID_PACKAGE_NAME?.trim() || 'com.magicbooklet.mobile';
  const sha256CertFingerprints = fingerprints();
  const body = sha256CertFingerprints.length > 0 ? [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: packageName,
      sha256_cert_fingerprints: sha256CertFingerprints,
    },
  }] : [];

  return NextResponse.json(body, {
    headers: {
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
      'Content-Type': 'application/json',
    },
  });
}
