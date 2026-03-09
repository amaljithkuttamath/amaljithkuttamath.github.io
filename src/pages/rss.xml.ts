import rss from '@astrojs/rss';
import type { APIContext } from 'astro';

export async function GET(context: APIContext) {
  const allPosts = import.meta.glob('./work/*.md', { eager: true }) as Record<string, any>;
  const posts = Object.entries(allPosts)
    .map(([path, mod]) => ({
      title: mod.frontmatter.title,
      description: mod.frontmatter.description || '',
      pubDate: new Date(mod.frontmatter.date),
      link: '/work/' + path.replace('./work/', '').replace('.md', ''),
    }))
    .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

  return rss({
    title: 'Amaljith Kuttamath',
    description: 'AI Engineer. Building things that think.',
    site: context.site!.href,
    items: posts,
  });
}
