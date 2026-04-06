import { RequireAuth } from '@/app/components/RouteAuthBoundary';

import NewPostClient from './NewPostClient';

export default function NewPostPage() {
  return (
    <RequireAuth returnTo="/post/new">
      <NewPostClient />
    </RequireAuth>
  );
}
