import type { Metadata } from "next";
import { POSTS } from "@/lib/blog";
import { pageMetadata } from "@/lib/site";
import { BlogCard } from "@/components/BlogCard";

export const metadata: Metadata = pageMetadata(
  "Blog",
  "Market news and plain guides to how Kadex works: the graded card market, the index price, hedging a collection and the devnet launch.",
  "/blog",
);

export default function BlogPage() {
  const [lead, ...rest] = POSTS;

  return (
    <div className="page wide">
      <header className="vmkt-head">
        <h1>
          Kadex <span>blog</span>
        </h1>
        <p className="vmkt-total">
          Market news and guides <b>{POSTS.length} posts</b>
        </p>
      </header>

      <div className="blog-grid">
        {lead && <BlogCard post={lead} featured />}
        {rest.map((post) => (
          <BlogCard key={post.slug} post={post} />
        ))}
      </div>
    </div>
  );
}
