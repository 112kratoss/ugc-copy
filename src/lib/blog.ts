import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { remark } from 'remark';
import html from 'remark-html';

const postsDirectory = path.join(process.cwd(), 'content/blog');

export interface BlogPost {
    slug: string;
    title: string;
    date: string;
    excerpt: string;
    seoTitle?: string;
    seoDescription?: string;
    coverImage?: string;
    content: string;
}

export function getSortedPostsData(): Omit<BlogPost, 'content'>[] {
    if (!fs.existsSync(postsDirectory)) return [];
    const fileNames = fs.readdirSync(postsDirectory);
    const allPostsData = fileNames.filter(name => name.endsWith('.md')).map((fileName) => {
        const slug = fileName.replace(/\.md$/, '');
        const fullPath = path.join(postsDirectory, fileName);
        const fileContents = fs.readFileSync(fullPath, 'utf8');
        const matterResult = matter(fileContents);

        return {
            slug,
            title: matterResult.data.title || 'Untitled',
            date: matterResult.data.date || new Date().toISOString(),
            excerpt: matterResult.data.excerpt || '',
            seoTitle: matterResult.data.seoTitle || undefined,
            seoDescription: matterResult.data.seoDescription || undefined,
            coverImage: matterResult.data.coverImage || undefined,
        };
    });

    return allPostsData.sort((a, b) => {
        if (a.date < b.date) {
            return 1;
        } else {
            return -1;
        }
    });
}

export async function getPostData(slug: string): Promise<BlogPost> {
    const fullPath = path.join(postsDirectory, `${slug}.md`);
    const fileContents = fs.readFileSync(fullPath, 'utf8');
    const matterResult = matter(fileContents);

    const processedContent = await remark()
        .use(html)
        .process(matterResult.content);
    const contentHtml = processedContent.toString();

    return {
        slug,
        title: matterResult.data.title || 'Untitled',
        date: matterResult.data.date || new Date().toISOString(),
        excerpt: matterResult.data.excerpt || '',
        seoTitle: matterResult.data.seoTitle || undefined,
        seoDescription: matterResult.data.seoDescription || undefined,
        coverImage: matterResult.data.coverImage || undefined,
        content: contentHtml,
    };
}
