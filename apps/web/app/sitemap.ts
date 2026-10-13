import type { MetadataRoute } from "next";
import { POSTS } from "@/lib/blog";
import { SITE_URL } from "@/lib/site";

const PAGES = [
  { path: "/", priority: 1, changeFrequency: "hourly" },
  { path: "/pool", priority: 0.8, changeFrequency: "daily" },
  { path: "/vault", priority: 0.8, changeFrequency: "daily" },
  { path: "/index-methodology", priority: 0.6, changeFrequency: "monthly" },
  { path: "/blog", priority: 0.7, changeFrequency: "weekly" },
  ...POSTS.map((post) => ({ path: `/blog/${post.slug}`, priority: 0.5, changeFrequency: "monthly" as const })),
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return PAGES.map(({ path, priority, changeFrequency }) => ({
    url: `${SITE_URL}${path === "/" ? "" : path}`,
    lastModified,
    changeFrequency,
    priority,
  }));
}
