import { expect, test } from '@playwright/test';
import fixture from '../../contracts/model-catalog-transport-v1.json';

test.beforeEach(async ({ context }) => {
  await context.addCookies([
    { name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' },
  ]);
});
for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`loads a remote model and refreshes only on picker entry (${viewport.width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    let revision = fixture.current.revision;
    let revisionReads = 0;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/model-catalog/v1/**', async (route) => {
      const url = new URL(route.request().url());
      let body: unknown;
      if (url.pathname.endsWith('/current')) {
        revisionReads++;
        body = { ...fixture.current, revision };
      } else if (url.pathname.endsWith('/models'))
        body = { ...fixture.page, revision };
      else {
        const ids = (url.searchParams.get('ids') ?? '').split(',');
        const models = fixture.details.models
          .filter((m) => ids.includes(m.id))
          .map((m) => ({
            ...m,
            displayName:
              revision === 'updated-catalog'
                ? 'Updated Future Model'
                : m.displayName,
          }));
        body = {
          ...fixture.details,
          revision,
          models,
          missingIds: ids.filter((id) => !models.some((m) => m.id === id)),
        };
      }
      await route.fulfill({ json: body });
    });
    await page.route('**/api/generation-models/quote', (route) =>
      route.fulfill({
        json: {
          modelId: 'future-image-model',
          kind: 'image',
          costCredits: 6,
          catalogRevision: revision,
          normalizedSettings: {
            aspectRatio: '1:1',
            background: 'auto',
            googleSearch: false,
          },
        },
      }),
    );
    await page.goto(
      '/create-image?model=future-image-model&prompt=Original%20deep%20link',
    );
    const prompt = page.locator('textarea').first();
    await expect(prompt).toHaveValue('Original deep link');
    await prompt.fill('Keep my edited prompt');
    await expect(
      page.getByRole('button', { name: /Future Image Model/ }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole('combobox', { name: 'Background', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('combobox', { name: 'Background', exact: true })
      .selectOption('transparent');
    await expect(
      page.getByRole('combobox', { name: 'Background', exact: true }),
    ).toHaveValue('transparent');
    const before = revisionReads;
    revision = 'updated-catalog';
    await page
      .getByRole('button', { name: /Future Image Model/ })
      .first()
      .click();
    await expect.poll(() => revisionReads).toBeGreaterThan(before);
    await expect(
      page.getByRole('button', { name: /Updated Future Model/ }).first(),
    ).toBeVisible();
    await expect(prompt).toHaveValue('Keep my edited prompt');
    expect(errors).toEqual([]);
    await page.screenshot({
      path: `test-results/model-catalog-${viewport.width}.png`,
      fullPage: true,
    });
  });
}

for (const kind of ['video', 'motion'] as const) {
  test(`renders descriptor controls for a remote ${kind} model`, async ({
    page,
    request,
  }) => {
    const current = await (
      await request.get('/api/model-catalog/v1/current')
    ).json();
    const details = await (
      await request.get(
        `/api/model-catalog/v1/details?revision=${current.revision}&ids=${current.defaults[kind]}`,
      )
    ).json();
    const model = {
      ...details.models[0],
      id: `remote-${kind}-model`,
      displayName: `Remote ${kind} model`,
      controls: [
        ...details.models[0].controls,
        {
          key: 'newOption',
          label: 'New catalog option',
          type: 'boolean',
          presentation: 'toggle',
          defaultValue: true,
        },
      ],
    };
    const revision = `browser-${kind}-revision`;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/model-catalog/v1/**', async (route) => {
      const url = new URL(route.request().url());
      const ids = (url.searchParams.get('ids') ?? '').split(',');
      const body = url.pathname.endsWith('/current')
        ? {
            ...current,
            revision,
            defaults: {
              image: null,
              video: null,
              motion: null,
              [kind]: model.id,
            },
          }
        : url.pathname.endsWith('/models')
          ? {
              transportVersion: 1,
              revision,
              models: [
                {
                  id: model.id,
                  kind,
                  displayName: model.displayName,
                  description: model.description,
                  badge: model.badge,
                  recommended: model.recommended,
                  sortOrder: model.sortOrder,
                },
              ],
              nextCursor: null,
            }
          : {
              transportVersion: 1,
              descriptorSchemaVersion: 3,
              revision,
              models: ids.includes(model.id) ? [model] : [],
              missingIds: ids.filter((id) => id !== model.id),
            };
      await route.fulfill({ json: body });
    });
    await page.goto(`/create-${kind}?model=${model.id}`);
    await expect(
      page.getByRole('button', { name: new RegExp(model.displayName) }).first(),
    ).toBeVisible();
    const control = page.getByRole('checkbox', { name: 'New catalog option' });
    await expect(control).toBeChecked();
    await control.uncheck();
    await expect(control).not.toBeChecked();
    expect(errors).toEqual([]);
  });
}
