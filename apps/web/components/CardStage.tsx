"use client";

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";

const DEGREES_PER_PIXEL = 0.5;
const MAX_PITCH = 38;

const facing = (yaw: number) => {
  const turned = ((yaw % 360) + 360) % 360;
  return turned > 90 && turned < 270;
};

const nearest = (yaw: number, back: boolean) => {
  const target = back ? 180 : 0;
  return yaw + ((((target - yaw) % 360) + 540) % 360) - 180;
};

export function CardStage({
  front,
  back,
  showBack,
  onFace,
}: {
  front: string | null;
  back: string | null;
  showBack: boolean;
  onFace: (back: boolean) => void;
}) {
  const [yaw, setYaw] = useState(0);
  const [pitch, setPitch] = useState(0);
  const [dragging, setDragging] = useState(false);
  const last = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    setYaw((current) => (facing(current) === showBack ? current : nearest(current, showBack)));
  }, [showBack]);

  if (!front) return <span className="vblank">No photo</span>;

  const down = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    last.current = { x: e.clientX, y: e.clientY };
    setDragging(true);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const from = last.current;
    if (!from) return;
    last.current = { x: e.clientX, y: e.clientY };
    setYaw((v) => v + (e.clientX - from.x) * DEGREES_PER_PIXEL);
    setPitch((v) => Math.max(-MAX_PITCH, Math.min(MAX_PITCH, v - (e.clientY - from.y) * DEGREES_PER_PIXEL)));
  };
  const up = () => {
    if (!last.current) return;
    last.current = null;
    setDragging(false);
    if (back && facing(yaw) !== showBack) onFace(facing(yaw));
  };
  const reset = () => {
    setPitch(0);
    setYaw((v) => nearest(v, false));
    if (showBack) onFace(false);
  };

  const glare = (((yaw % 360) + 360) % 360) / 3.6;
  const shade = Math.abs(Math.sin((yaw * Math.PI) / 180)) * 0.42 + Math.abs(pitch) * 0.004;
  const style = {
    transform: `rotateX(${pitch}deg) rotateY(${yaw}deg)`,
    "--glare": `${glare}%`,
    "--shade": shade.toFixed(3),
  } as CSSProperties;

  return (
    <div className="stage" data-dragging={dragging}>
      <div
        className="stage-hit"
        role="img"
        aria-label="Card in its case. Drag to turn it in any direction, double-click to reset."
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onDoubleClick={reset}
      >
        <div className="stage-float">
          <div className="stage-spin">
          <div className="stage-card" style={style}>
            <span className="side left" />
            <span className="side right" />
            <span className="side top" />
            <span className="side bottom" />
            <img className="face" src={front} alt="" draggable={false} />
            {back ? <img className="face back" src={back} alt="" draggable={false} /> : <span className="face back blank" />}
            <span className="glare" />
            <span className="shade" />
            <span className="shade back" />
          </div>
          </div>
        </div>
      </div>

      <div className="stage-shadow" aria-hidden="true" />
      <div className="pedestal" aria-hidden="true">
        <span className="ped-glow" />
        <span className="ped-body" />
        <span className="ped-top" />
      </div>
      <p className="stage-hint" aria-hidden="true">Drag to rotate</p>
    </div>
  );
}
