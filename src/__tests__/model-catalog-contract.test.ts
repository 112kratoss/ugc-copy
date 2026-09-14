import { expect, it } from 'vitest';
import fixture from '../../contracts/model-catalog-transport-v1.json';
import { parseClientGenerationModelCatalog } from '@/lib/generation-model-client';
import {
  parseModelCatalogCurrent,
  parseModelCatalogPage,
} from '../../ugc-mobile/lib/model-catalog/protocol';
it('web consumes the same future-model transport contract as mobile', () => {
  expect(parseModelCatalogCurrent(fixture.current)).toEqual(fixture.current);
  expect(parseModelCatalogPage(fixture.page, fixture.current.revision)).toEqual(
    fixture.page,
  );
  const catalog = parseClientGenerationModelCatalog({
    schemaVersion: 3,
    revision: fixture.current.revision,
    defaults: fixture.current.defaults,
    models: fixture.details.models,
  });
  expect(catalog.models[0].id).toBe('future-image-model');
  expect(catalog.models[0].controls.at(-1)?.conditions).toEqual(
    fixture.details.models[0].controls.at(-1)?.conditions,
  );
});
