import { useRef, useState } from "react";
import { Upload } from "lucide-react";

/* A file input renders its button and its "no file chosen" from the operating
   system, and nothing in a stylesheet reaches either. The real input is kept
   for the file dialog and everything visible is drawn. */

export function FileInput({
  accept,
  placeholder = "No file chosen",
  onChoose,
}: {
  accept?: string;
  placeholder?: string;
  onChoose: (file: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<string | null>(null);

  return (
    <div className="file-input">
      <button type="button" className="ghost" onClick={() => input.current?.click()}>
        <Upload size={15} aria-hidden="true" />
        Choose a file
      </button>
      <span className={chosen ? "truncate" : "truncate muted"}>{chosen ?? placeholder}</span>
      <input
        ref={input}
        type="file"
        accept={accept}
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            setChosen(file.name);
            onChoose(file);
          }
          // So choosing the same file twice still fires.
          event.target.value = "";
        }}
      />
    </div>
  );
}
