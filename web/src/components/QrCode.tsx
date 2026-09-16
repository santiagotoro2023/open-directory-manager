import QRCode from "qrcode";

/**
 * A QR code drawn locally as plain rectangles. Nothing in it leaves the
 * page: a topic name is a secret, and a rendering service would be a
 * third party holding it.
 */
export function QrCode({ value, label, scale = 5 }: { value: string; label: string; scale?: number }) {
  const symbol = QRCode.create(value, { errorCorrectionLevel: "M" });
  const size = symbol.modules.size;
  const bits = symbol.modules.data;
  const quiet = 4;
  const side = (size + quiet * 2) * scale;
  const cells: React.ReactNode[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (bits[y * size + x]) {
        cells.push(
          <rect
            key={`${x}-${y}`}
            x={(x + quiet) * scale}
            y={(y + quiet) * scale}
            width={scale}
            height={scale}
            fill="#0f172a"
          />,
        );
      }
    }
  }
  return (
    <svg width={side} height={side} viewBox={`0 0 ${side} ${side}`} role="img" aria-label={label}>
      <rect width={side} height={side} fill="#ffffff" />
      {cells}
    </svg>
  );
}
