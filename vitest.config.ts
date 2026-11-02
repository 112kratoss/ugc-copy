import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    test: {
        environment: 'jsdom',
        globals: true,
        setupFiles: ['./src/__tests__/setup.ts'],
        include: ['src/**/*.test.{ts,tsx}'],
        // A test's whole budget, not one wait's: setup.ts caps each findBy/waitFor at 5 s, so a wrong
        // screen still fails there, while a test that draws a heavy page and waits several times needs
        // more than 5 s in all on CI's shared runner. At vitest's 5 s default, create-workflow-page's
        // "shows save discard cancel" (1.2–1.6 s on an idle Mac, 4.1–5.4 s at background CPU priority)
        // failed main's Quality and skipped releases. Give a test its own timeout only above this
        // one, or below it where a short bound is what the test checks. The *-postgrest files run on
        // CI under their own vitest.*-postgrest configs, which keep vitest's 5 s default, so their
        // per-test timeouts stay; the *-database files CI's migration job runs use this config.
        testTimeout: 20_000,
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, 'src'),
            'server-only': path.resolve(__dirname, 'src/__tests__/mocks/server-only.ts'),
        },
    },
});
