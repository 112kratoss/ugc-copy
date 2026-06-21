export function isAuthorizedCronRequest(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return false;
  }

  return request.headers.get('authorization') === `Bearer ${secret}`;
}
