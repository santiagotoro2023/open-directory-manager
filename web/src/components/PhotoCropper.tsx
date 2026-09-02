import { useCallback, useEffect, useRef, useState } from "react";

/** What the directory stores: a square picture, 256 across. */
export const PHOTO_SIZE = 256;

interface Placement {
  /** Scale applied to the source image, 1 = it exactly covers the frame. */
  zoom: number;
  /** Offset of the image centre from the frame centre, in frame pixels. */
  x: number;
  y: number;
}

/**
 * Choose the part of a picture that becomes the account's.
 *
 * A photograph off a phone is several megabytes and the wrong shape; the
 * directory holds a small square one, shown as a circle by every greeter and
 * desktop that reads it. So the picture is framed here — drag to move, the
 * slider to zoom — and what is saved is exactly what the circle shows, scaled
 * to 256×256 and encoded as JPEG.
 */
export function PhotoCropper({
  file,
  onCropped,
}: {
  file: File;
  /** Base64 JPEG, no data: prefix. */
  onCropped: (base64: string) => void;
}) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [placement, setPlacement] = useState<Placement>({ zoom: 1, x: 0, y: 0 });
  const [error, setError] = useState<string | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const loading = new Image();
    loading.onload = () => {
      setImage(loading);
      setPlacement({ zoom: 1, x: 0, y: 0 });
      setError(null);
    };
    loading.onerror = () => setError("That file could not be read as a picture.");
    loading.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // The frame is square on screen; the picture covers it at zoom 1 whichever
  // way round it is, so there is never a gap to drag into view.
  const cover = image ? Math.max(1, image.width / image.height, image.height / image.width) : 1;

  const render = useCallback(() => {
    if (!image) return;
    const canvas = document.createElement("canvas");
    canvas.width = PHOTO_SIZE;
    canvas.height = PHOTO_SIZE;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, PHOTO_SIZE, PHOTO_SIZE);

    // The frame on screen is FRAME px; the same placement at PHOTO_SIZE.
    const ratio = PHOTO_SIZE / FRAME;
    const scale = (PHOTO_SIZE / Math.min(image.width, image.height)) * placement.zoom;
    const width = image.width * scale;
    const height = image.height * scale;
    context.drawImage(
      image,
      PHOTO_SIZE / 2 - width / 2 + placement.x * ratio,
      PHOTO_SIZE / 2 - height / 2 + placement.y * ratio,
      width,
      height,
    );
    onCropped(canvas.toDataURL("image/jpeg", 0.9).split(",")[1] ?? "");
  }, [image, placement, onCropped]);

  // Every move produces the picture that would be saved, so what the circle
  // shows and what is stored cannot come apart.
  useEffect(() => {
    render();
  }, [render]);

  function move(event: React.PointerEvent) {
    if (!dragging.current) return;
    const bounds = limit(placement.zoom * cover);
    setPlacement((current) => ({
      ...current,
      x: clamp(current.x + event.clientX - dragging.current!.x, bounds),
      y: clamp(current.y + event.clientY - dragging.current!.y, bounds),
    }));
    dragging.current = { x: event.clientX, y: event.clientY };
  }

  if (error) {
    return (
      <p className="alert" role="alert">
        {error}
      </p>
    );
  }
  if (!image) return <p className="muted">Reading the picture…</p>;

  const scale = (FRAME / Math.min(image.width, image.height)) * placement.zoom;

  return (
    <div className="photo-cropper">
      <div
        ref={frame}
        className="photo-frame"
        onPointerDown={(event) => {
          dragging.current = { x: event.clientX, y: event.clientY };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={move}
        onPointerUp={() => (dragging.current = null)}
        onPointerCancel={() => (dragging.current = null)}
      >
        <img
          src={image.src}
          alt=""
          draggable={false}
          style={{
            width: image.width * scale,
            height: image.height * scale,
            transform: `translate(calc(-50% + ${placement.x}px), calc(-50% + ${placement.y}px))`,
          }}
        />
        <div className="photo-mask" aria-hidden="true" />
      </div>

      <label className="field">
        <span>Zoom</span>
        <input
          type="range"
          min={1}
          max={4}
          step={0.01}
          value={placement.zoom}
          onChange={(e) => {
            const zoom = Number(e.target.value);
            const bounds = limit(zoom * cover);
            setPlacement((current) => ({
              zoom,
              x: clamp(current.x, bounds),
              y: clamp(current.y, bounds),
            }));
          }}
        />
        <small>Drag the picture to move it. What the circle shows is what is saved.</small>
      </label>
    </div>
  );
}

/** The frame's size on screen. */
const FRAME = 220;

/** How far the picture may be dragged before an edge would come into view. */
function limit(scale: number): number {
  return Math.max(0, (FRAME * scale - FRAME) / 2);
}

function clamp(value: number, bound: number): number {
  return Math.min(bound, Math.max(-bound, value));
}
