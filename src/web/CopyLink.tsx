import { useState } from "react";

/** A read-only link with a Copy button. */
export function CopyLink({ url }: { url: string }) {
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
