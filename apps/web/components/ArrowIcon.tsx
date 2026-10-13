type Direction = "right" | "left" | "external";

export function ArrowIcon({ direction = "right" }: { direction?: Direction }) {
  const path = direction === "external"
    ? <><path d="M7 17 17 7" /><path d="M9 7h8v8" /></>
    : direction === "left"
      ? <path d="m14 6-6 6 6 6" />
      : <path d="m10 6 6 6-6 6" />;

  return (
    <svg className="arrow-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {path}
    </svg>
  );
}
