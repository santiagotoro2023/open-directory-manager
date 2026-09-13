import { useEffect, useState } from "react";

/* FileInput's onChoose can be async — reading a large picture through a
 * canvas to convert it to PNG (see readImageAsPng in SettingsEditor) takes
 * real time. Nothing about picking a file blocked the page's own Save
 * button while that was in flight, which let a save fire before the read
 * finished and persist the setting without the image at all — chosen in
 * the UI, but never actually in the payload that got saved. Module-level
 * rather than React context: the button that needs to know sits above the
 * editor tree that owns the upload, not below it, so there is no shared
 * ancestor to hang a context provider from without a much larger refactor. */

let pending = 0;
const listeners = new Set<(count: number) => void>();

function notify() {
  for (const listener of listeners) listener(pending);
}

export function beginUpload() {
  pending += 1;
  notify();
}

export function endUpload() {
  pending = Math.max(0, pending - 1);
  notify();
}

export function useUploadsPending(): number {
  const [count, setCount] = useState(pending);
  useEffect(() => {
    listeners.add(setCount);
    setCount(pending);
    return () => {
      listeners.delete(setCount);
    };
  }, []);
  return count;
}
