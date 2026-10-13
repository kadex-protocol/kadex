import Link from "next/link";
import { fmtPostDate, type BlogPost } from "@/lib/blog";

export function BlogCard({ post, featured = false }: { post: BlogPost; featured?: boolean }) {
  return (
    <Link href={`/blog/${post.slug}`} className={featured ? "panel bcard feat" : "panel bcard"}>
      <span className="bcard-cover">
        <img
          src={post.cover}
          alt={post.coverAlt}
          loading="lazy"
          style={featured && post.coverFocus ? { objectPosition: post.coverFocus } : undefined}
        />
      </span>
      <span className="bcard-body">
        <span className="bcard-meta">
          <b>{post.tag}</b>
          {fmtPostDate(post.date)} · {post.minutes} min read
        </span>
        <strong>{post.title}</strong>
        <span className="bcard-text">{post.excerpt}</span>
        <span className="bcard-more">Read the post ›</span>
      </span>
    </Link>
  );
}
