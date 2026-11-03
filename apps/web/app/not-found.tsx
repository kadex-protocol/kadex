import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <div className="page">
      <section className="empty">
        <h1 className="title">Page not found</h1>
        <p>The page you are looking for could not be found.</p>
        <div className="actions not-found-actions">
          <Link href="/" className="btn accent">Back to Trade</Link>
          <Link href="/vault" className="btn">Go to Vault</Link>
        </div>
      </section>
    </div>
  );
}
