import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { beginUpload, endUpload } from "../uploadTracker";

/* A file input renders its button and its "no file chosen" from the operating
   system, and nothing in a stylesheet reaches either. The real input is kept
   for the file dialog and everything visible is drawn.

   onChoose may be async (reading a large picture through a canvas to convert
   it to PNG genuinely takes time) — this now actually waits for it before
   calling itself "chosen" and before letting go of the shared upload
   counter, rather than showing the file name and returning immediately
   while the real work, and the state a page's Save button reads, was still
   pending. That gap used to let a save fire before an upload had actually
   reached the settings object being saved. */
export function FileInput({
  accept,
  placeholder = "No file chosen",
  onChoose,
}: {
  accept?: string;
  placeholder?: string;
  onChoose: (file: File) => void | Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="file-input">
      <button
        type="button"
        className="ghost"
        onClick={() => input.current?.click()}
        disabled={reading}
      >
        <Upload size={15} aria-hidden="true" />
        Choose a file
      </button>
      <span className={chosen && !reading && !error ? "truncate" : "truncate muted"}>
        {reading ? "Reading…" : (error ?? chosen ?? placeholder)}
      </span>
      <input
        ref={input}
        type="file"
        accept={accept}
        className="sr-only"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          // So choosing the same file twice still fires.
          event.target.value = "";
          if (!file) return;
          setReading(true);
          setError(null);
          beginUpload();
          try {
            await onChoose(file);
            setChosen(file.name);
          } catch (err) {
            // A failure here used to be entirely silent: nothing changed,
            // nothing explained why, and the setting quietly saved without
            // the picture. Shown in the same place the file name would
            // have gone, since that is where an operator is already
            // looking to confirm the upload worked.
            setError(err instanceof Error ? err.message : "could not read this file");
          } finally {
            setReading(false);
            endUpload();
          }
        }}
      />
    </div>
  );
}
