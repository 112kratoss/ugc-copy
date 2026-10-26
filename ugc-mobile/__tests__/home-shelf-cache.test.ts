import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import { refreshHomeShelf, takeOffHomeShelf } from '../lib/home-shelf-cache';
import type { HomeShelfResponse } from '../lib/types';

const memberShelf = (mobileApiContract.endpoints.getHomeShelf as unknown as {
  responseVariants: { member: { response: HomeShelfResponse } };
}).responseVariants.member.response;

function clientWithShelf() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(['home-shelf', 'user-2'], memberShelf);
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const ids = () => queryClient.getQueryData<HomeShelfResponse>(['home-shelf', 'user-2'])?.items.map((item) => item.id);
  return { queryClient, invalidate, ids };
}

describe('takeOffHomeShelf', () => {
  it("takes a reported or hidden post's card off at once, and marks the shelf stale without reading it", () => {
    const { queryClient, invalidate, ids } = clientWithShelf();

    takeOffHomeShelf(queryClient, { postId: 'post-2' });

    expect(ids()).toEqual(['post-1', 'post', 'post-3', 'invite']);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['home-shelf'], refetchType: 'none' });
  });

  it("takes every card of a blocked or hidden creator off, and leaves the offers", () => {
    const { queryClient, ids } = clientWithShelf();

    takeOffHomeShelf(queryClient, { creatorId: 'user-1' });

    expect(ids()).toEqual(['post', 'invite']);
  });

  it('leaves the shelf alone for someone else', () => {
    const { queryClient, ids } = clientWithShelf();

    takeOffHomeShelf(queryClient, { creatorId: 'someone-else', postId: 'not-pinned' });

    expect(ids()).toEqual(['post-1', 'post-2', 'post', 'post-3', 'invite']);
  });
});

describe('refreshHomeShelf', () => {
  it('reads the shelf again after an unblock, which may bring a creator back', () => {
    const { queryClient, invalidate } = clientWithShelf();

    refreshHomeShelf(queryClient);

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['home-shelf'] });
  });
});
