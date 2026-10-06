import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requireAdminIdentity, createServiceClient } = vi.hoisted(() => ({
  requireAdminIdentity: vi.fn(),
  createServiceClient: vi.fn(() => { throw new Error('Audit privileged client created before authorization'); }),
}));
vi.mock('@/lib/admin-auth', () => ({ requireAdminIdentity }));
vi.mock('@/lib/server-helpers', () => ({ createServiceClient }));

import Overview from '@/app/admin/(console)/page';
import Activity from '@/app/admin/(console)/activity/page';
import Content from '@/app/admin/(console)/content/page';
import Revenue from '@/app/admin/(console)/revenue/page';
import System from '@/app/admin/(console)/system/page';
import Users from '@/app/admin/(console)/users/page';
import UserDetail from '@/app/admin/(console)/users/[userId]/page';
import Payouts from '@/app/admin/(console)/payouts/page';
import Moderation from '@/app/admin/(console)/moderation/page';
import History from '@/app/admin/(console)/moderation/history/page';

const pages = [
  { name: 'overview', run: () => Overview() },
  { name: 'activity', run: () => Activity({ searchParams: Promise.resolve({}) }) },
  { name: 'content', run: () => Content({ searchParams: Promise.resolve({}) }) },
  { name: 'revenue', run: () => Revenue({ searchParams: Promise.resolve({}) }) },
  { name: 'system', run: () => System({ searchParams: Promise.resolve({}) }) },
  { name: 'users', run: () => Users({ searchParams: Promise.resolve({}) }) },
  { name: 'user detail', run: () => UserDetail({ params: Promise.resolve({ userId: '10000000-0000-4000-8000-000000000001' }) }) },
  { name: 'payouts', run: () => Payouts({ searchParams: Promise.resolve({}) }) },
  { name: 'moderation', run: () => Moderation() },
  { name: 'moderation history', run: () => History({ searchParams: Promise.resolve({}) }) },
];

describe('admin pages stop before privileged reads when authorization is denied', () => {
  const denied = new Error('Audit authorization denied');
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminIdentity.mockRejectedValue(denied);
  });
  it.each(pages)('gates $name independently of its parent layout', async ({ run }) => {
    const error = await run().catch(cause => cause);
    expect({ error, clientCreated: createServiceClient.mock.calls.length }).toEqual({ error: denied, clientCreated: 0 });
    expect(requireAdminIdentity).toHaveBeenCalledTimes(1);
  });
});
