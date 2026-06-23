import 'server-only';

import { NextResponse } from 'next/server';

import { API_CACHE_CONTROL, createApiResponseHeaders } from '@/lib/api-cache';
import { MOBILE_CLIENT_COMPATIBILITY_POLICY } from '@/lib/mobile-client-compatibility';

type AppVersionEnvironment = {
  VERCEL_GIT_COMMIT_SHA?: string;
  VERCEL_DEPLOYMENT_ID?: string;
  VERCEL_URL?: string;
};

function firstNonEmpty(values: Array<string | undefined>): string | null {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function resolveBuildId(environment: AppVersionEnvironment): string {
  return firstNonEmpty([
    environment.VERCEL_GIT_COMMIT_SHA,
    environment.VERCEL_DEPLOYMENT_ID,
    environment.VERCEL_URL,
  ]) ?? 'dev';
}

function readProcessEnvironment(): AppVersionEnvironment {
  return {
    VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
    VERCEL_DEPLOYMENT_ID: process.env.VERCEL_DEPLOYMENT_ID,
    VERCEL_URL: process.env.VERCEL_URL,
  };
}

export async function getAppVersionRouteResponse({
  environment = readProcessEnvironment(),
  request,
}: {
  environment?: AppVersionEnvironment;
  request: Request;
}) {
  return NextResponse.json(
    {
      buildId: resolveBuildId(environment),
      mobileCompatibility: MOBILE_CLIENT_COMPATIBILITY_POLICY,
    },
    {
      headers: createApiResponseHeaders(request, API_CACHE_CONTROL.appVersionNoStore),
    }
  );
}
