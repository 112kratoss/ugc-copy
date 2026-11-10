import { createAdminReferralReviewRouteHandlers } from '@/lib/admin-referral-review-route-adapter-service';

export const runtime = 'nodejs';

export const { POST } = createAdminReferralReviewRouteHandlers();
