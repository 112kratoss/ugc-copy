import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import DeleteAccountPage from '@/app/delete-account/page';

describe('account deletion page', () => {
    it('publishes store-compliant deletion steps and retention information', () => {
        const html = renderToString(<DeleteAccountPage />);

        expect(html).toContain('Delete your Magic Booklet account');
        expect(html).toContain('Open Profile, then Settings');
        expect(html).toContain('type DELETE');
        expect(html).toContain('What permanent deletion removes');
        expect(html).toContain('Data we may retain');
        expect(html).toContain('Request account deletion');
    });
});
