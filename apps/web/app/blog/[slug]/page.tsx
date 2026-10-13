import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { fmtPostDate, postBySlug, POSTS, type BlogBlock } from "@/lib/blog";
import { BRAND } from "@/lib/brand";
import { BlogCard } from "@/components/BlogCard";

type Params = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return POSTS.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const post = postBySlug((await params).slug);
  if (!post) return {};
  const path = `/blog/${post.slug}`;
  const title = `${post.title} · ${BRAND}`;
  const images = [{ url: post.cover, width: 1600, height: 900, alt: post.coverAlt }];
  return {
    title: post.title,
    description: post.excerpt,
    alternates: { canonical: path },
    openGraph: { type: "article", siteName: BRAND, locale: "en_US", title, description: post.excerpt, url: path, publishedTime: post.date, images },
    twitter: { card: "summary_large_image", title, description: post.excerpt, images },
  };
}

function Block({ block }: { block: BlogBlock }) {
  switch (block.kind) {
    case "h":
      return <h2>{block.text}</h2>;
    case "p":
      return <p>{block.text}</p>;
    case "note":
      return <p className="post-note">{block.text}</p>;
    case "list":
      return (
        <ul>
          {block.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      );
    case "figures":
      return (
        <div className="post-figs">
          {block.items.map((item) => (
            <div key={item.label}>
              <b>{item.value}</b>
              <span>{item.label}</span>
            </div>
          ))}
        </div>
      );
    case "links":
      return (
        <div className="post-links">
          {block.items.map((item) => (
            <a key={item.href} href={item.href} target="_blank" rel="noreferrer">
              <b>{item.label}</b>
              <i>{item.note}</i>
              <span>Explorer ›</span>
            </a>
          ))}
        </div>
      );
  }
}

export default async function PostPage({ params }: Params) {
  const post = postBySlug((await params).slug);
  if (!post) notFound();
  const others = POSTS.filter((other) => other.slug !== post.slug).slice(0, 3);
  const external = post.cta.href.startsWith("http");

  return (
    <div className="page wide blogp">
      <div className="post-wrap">
        <article className="panel post">
          <header className="post-head">
            <Link href="/blog" className="post-back">‹ Blog</Link>
            <p className="bcard-meta">
              <b>{post.tag}</b>
              {fmtPostDate(post.date)} · {post.minutes} min read
            </p>
            <h1>{post.title}</h1>
            <p className="post-lead">{post.excerpt}</p>
          </header>

          <figure className="post-cover">
            <img src={post.cover} alt={post.coverAlt} />
            {post.credit && (
              <figcaption>
                <a href={post.credit.href} target="_blank" rel="noreferrer">{post.credit.text}</a>
              </figcaption>
            )}
          </figure>

          <div className="post-body">
            {post.blocks.map((block, i) => (
              <Block key={i} block={block} />
            ))}

            {post.sources && (
              <section className="post-sources">
                <h2>Sources</h2>
                {post.sources.map((source) => (
                  <a key={source.href} href={source.href} target="_blank" rel="noreferrer">{source.label}</a>
                ))}
              </section>
            )}

            {external ? (
              <a href={post.cta.href} target="_blank" rel="noreferrer" className="btn accent">{post.cta.label}</a>
            ) : (
              <Link href={post.cta.href} className="btn accent">{post.cta.label}</Link>
            )}
          </div>
        </article>

        <aside className="post-more">
          <h2>Keep reading</h2>
          {others.map((other) => (
            <BlogCard key={other.slug} post={other} />
          ))}
        </aside>
      </div>
    </div>
  );
}
