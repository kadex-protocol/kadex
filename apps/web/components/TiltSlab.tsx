"use client";

import { useEffect, useState } from "react";
import Tilt from "react-parallax-tilt";

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return reduced;
}

export function TiltSlab({
  src,
  still = false,
}: {
  src: string | null;
  still?: boolean;
}) {
  const reduced = useReducedMotion();
  const [failed, setFailed] = useState<string | null>(null);

  if (!src || failed === src) return <span className="vblank">No photo</span>;

  const photo = <img src={src} alt="" loading="lazy" onError={() => setFailed(src)} />;
  if (still) return <span className="vslab">{photo}</span>;

  return (
    <Tilt
      className="vslab"
      tiltEnable={!reduced}
      tiltMaxAngleX={12}
      tiltMaxAngleY={12}
      perspective={700}
      scale={1.04}
      transitionSpeed={900}
      glareEnable={!reduced}
      glareMaxOpacity={0.24}
      glareColor="#ffffff"
      glarePosition="all"
    >
      {photo}
    </Tilt>
  );
}
