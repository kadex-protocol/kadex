export function Thumb({ src, alt = "" }: { src: string; alt?: string }) {
  return (
    <span className="thumb">
      <img src={src} alt={alt} loading="lazy" />
    </span>
  );
}
