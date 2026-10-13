import Link from "next/link";
import { POSTS } from "@/lib/blog";
import { BlogCard } from "@/components/BlogCard";

export function BlogSection() {
  const [lead, ...rest] = POSTS;

  return (
    <section className="blog" aria-labelledby="blog-h">
      <header className="how-head blog-head">
        <h2 id="blog-h">From the blog</h2>
        <p>Market news and plain guides to how Kadex works.</p>
        <Link href="/blog" className="blog-all">All posts ›</Link>
      </header>

      <div className="blog-grid">
        {lead && <BlogCard post={lead} featured />}
        {rest.map((post) => (
          <BlogCard key={post.slug} post={post} />
        ))}
      </div>
    </section>
  );
}
