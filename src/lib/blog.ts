import fs from 'fs';
import path from 'path';
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

type BlogFrontMatter = Partial<Omit<BlogPost, 'slug' | 'content'>>;

function unquoteFrontMatterValue(value: string): string {
    const trimmed = value.trim();
    if (
        (trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
        return trimmed.slice(1, -1);
    }

    return trimmed;
}

function parseBlogMarkdown(fileContents: string): { data: BlogFrontMatter; content: string } {
    if (!fileContents.startsWith('---\n')) {
        return { data: {}, content: fileContents };
    }

    const closingMarker = fileContents.indexOf('\n---\n', 4);
    if (closingMarker === -1) {
        return { data: {}, content: fileContents };
    }

    const frontMatter = fileContents.slice(4, closingMarker);
    const content = fileContents.slice(closingMarker + '\n---\n'.length);
    const data: BlogFrontMatter = {};

    for (const line of frontMatter.split('\n')) {
        const separatorIndex = line.indexOf(':');
        if (separatorIndex <= 0) continue;

        const key = line.slice(0, separatorIndex).trim() as keyof BlogFrontMatter;
        const value = unquoteFrontMatterValue(line.slice(separatorIndex + 1));
        if (key === 'title' || key === 'date' || key === 'excerpt' || key === 'seoTitle' || key === 'seoDescription' || key === 'coverImage') {
            data[key] = value;
        }
    }

    return { data, content };
}

export function getSortedPostsData(): Omit<BlogPost, 'content'>[] {
    if (!fs.existsSync(postsDirectory)) return [];
    const fileNames = fs.readdirSync(postsDirectory);
    const allPostsData = fileNames.filter(name => name.endsWith('.md')).map((fileName) => {
        const slug = fileName.replace(/\.md$/, '');
        const fullPath = path.join(postsDirectory, fileName);
        const fileContents = fs.readFileSync(fullPath, 'utf8');
        const parsedPost = parseBlogMarkdown(fileContents);

        return {
            slug,
            title: parsedPost.data.title || 'Untitled',
            date: parsedPost.data.date || new Date().toISOString(),
            excerpt: parsedPost.data.excerpt || '',
            seoTitle: parsedPost.data.seoTitle || undefined,
            seoDescription: parsedPost.data.seoDescription || undefined,
            coverImage: parsedPost.data.coverImage || undefined,
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
    const parsedPost = parseBlogMarkdown(fileContents);

    const processedContent = await remark()
        .use(html)
        .process(parsedPost.content);
    const contentHtml = processedContent.toString();

    return {
        slug,
        title: parsedPost.data.title || 'Untitled',
        date: parsedPost.data.date || new Date().toISOString(),
        excerpt: parsedPost.data.excerpt || '',
        seoTitle: parsedPost.data.seoTitle || undefined,
        seoDescription: parsedPost.data.seoDescription || undefined,
        coverImage: parsedPost.data.coverImage || undefined,
        content: contentHtml,
    };
}
