import { timingSafeEqual } from 'node:crypto';

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    const paddedLength = Math.max(leftBuffer.length, rightBuffer.length, 1);
    const paddedLeft = Buffer.alloc(paddedLength);
    const paddedRight = Buffer.alloc(paddedLength);
    leftBuffer.copy(paddedLeft);
    rightBuffer.copy(paddedRight);
    timingSafeEqual(paddedLeft, paddedRight);
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function configuredSecret(environment: NodeJS.ProcessEnv, key: string): string | null {
  const secret = environment[key]?.trim();
  return secret ? secret : null;
}

function isAuthorizedBearerRequest(
  request: Request,
  secretKeys: string[],
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const secrets = secretKeys
    .map((key) => configuredSecret(environment, key))
    .filter((secret): secret is string => Boolean(secret));

  if (secrets.length === 0) {
    return false;
  }

  const authorization = request.headers.get('authorization') ?? '';
  return secrets.some((secret) => timingSafeStringEqual(authorization, `Bearer ${secret}`));
}

export function isAuthorizedCronRequest(request: Request) {
  return isAuthorizedBearerRequest(request, ['CRON_SECRET']);
}

export function isAuthorizedOpsRequest(request: Request) {
  return isAuthorizedBearerRequest(request, ['OPS_READ_SECRET', 'CRON_SECRET']);
}
