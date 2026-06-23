import { describe, expect, it } from 'vitest';

import { getPostData, getSortedPostsData } from '@/lib/blog';

describe('blog content loader', () => {
  it('loads quoted front matter without a YAML parser dependency', () => {
    const posts = getSortedPostsData();

    expect(posts.length).toBeGreaterThan(0);
    expect(posts[0]).toMatchObject({
      slug: 'how-to-animate-a-photo-with-ai-motion-transfer',
      title: 'How to Animate a Photo With AI Motion Transfer',
      date: '2026-03-14',
      coverImage: '/opengraph-image.png',
    });
  });

  it('renders markdown content after stripping front matter', async () => {
    const post = await getPostData('ai-image-generator-for-ugc-ads');

    expect(post.seoTitle).toBe('AI Image Generator for UGC Ads');
    expect(post.content).toContain('<h2>Start With the Highest-Leverage Assets</h2>');
    expect(post.content).not.toContain('seoDescription:');
  });
});
