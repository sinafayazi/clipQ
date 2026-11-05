import { useState } from "react";

/** A read-only link with a Copy button. `onCopy` runs once it's on the clipboard. */
export function CopyLink({ url, onCopy }: { url: string; onCopy?: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-link">
      <input readOnly value={url} aria-label="OBS link" onFocus={(e) => e.currentTarget.select()} />
      <button
        type="button"
        className="btn"
        onClick={() =>
          navigator.clipboard.writeText(url).then(
            () => {
              onCopy?.();
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            },
            () => {},
          )
        }
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
