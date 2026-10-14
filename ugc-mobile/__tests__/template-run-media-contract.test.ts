import { describe, expect, it } from 'vitest';
import contract from '../../contracts/template-run-media-v1.json';
import { createApiClient } from '../lib/api-client';
import { templateRunLinkedPost } from '../lib/media-templates';

function apiAnswering(body: unknown) {
  return createApiClient({ baseUrl: 'https://app.test', getAccessToken: async () => 'token', fetcher: async () => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }) });
}

describe('template media wire contract', () => {
  it('absolutizes originals, playback and posters independently', async () => {
    const api = createApiClient({ baseUrl: 'https://app.test', getAccessToken: async () => 'token', fetcher: async () => new Response(JSON.stringify(contract.response), { headers: { "Content-Type": "application/json" } }) });
    const { run } = await api.getTemplateRun('contract-run');
    expect(run.result).toMatchObject({ url: 'https://app.test/original.mp4', renditionUrl: 'https://app.test/playback.mp4', previewUrl: 'https://app.test/poster.webp' });
    expect(run.steps[0]).toMatchObject({ outputUrl: 'https://app.test/original.mp4', renditionUrl: 'https://app.test/playback.mp4', previewUrl: 'https://app.test/poster.webp' });
  });
  it('accepts older responses and explicit null derivatives', async () => {
    const response = { run: { id: 'old', steps: [{ id: 'step', outputUrl: '/old.mp4', mediaKind: 'video' }], result: { kind: 'video', url: '/old.mp4', renditionUrl: null, previewUrl: null } } };
    const api = createApiClient({ baseUrl: 'https://app.test', getAccessToken: async () => 'token', fetcher: async () => new Response(JSON.stringify(response), { headers: { "Content-Type": "application/json" } }) });
    const { run } = await api.getTemplateRun('old');
    expect(run.result).toMatchObject({ url: 'https://app.test/old.mp4', renditionUrl: null, previewUrl: null });
    expect(run.steps[0]).not.toHaveProperty('renditionUrl');
  });
  it('passes the post a result was published as through, and none when there is none', async () => {
    const { run: unposted } = await apiAnswering(contract.response).getTemplateRun('contract-run');
    expect(unposted.result).toHaveProperty('linkedPost', null);
    expect(templateRunLinkedPost(unposted.result)).toBeNull();

    const posted = { run: { ...contract.response.run, result: { ...contract.response.run.result, linkedPost: { id: 'post-1', visibility: 'public' } } } };
    const { run } = await apiAnswering(posted).getTemplateRun('contract-run');
    expect(run.result).toMatchObject({ url: 'https://app.test/original.mp4', linkedPost: { id: 'post-1', visibility: 'public' } });
    expect(templateRunLinkedPost(run.result)).toEqual({ id: 'post-1', visibility: 'public' });
  });
});

it('keeps unavailable catalog media null on mobile', async () => {
  const api = createApiClient({ baseUrl: 'https://app.test', getAccessToken: async () => 'token', fetcher: async () => new Response(JSON.stringify(contract.unavailableDemoResponse), { headers: { 'Content-Type': 'application/json' } }) });
  expect((await api.getMediaTemplate('demo')).template).toMatchObject({ videoUrl: null, thumbnailUrl: null });
});
