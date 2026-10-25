import type { Provider } from "../shared/types";

export const PROVIDER_LABEL: Record<Provider, string> = {
  kick: "Kick",
  youtube: "YouTube",
  twitch: "Twitch",
  tiktok: "TikTok",
  x: "X",
  streamable: "Streamable",
};

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
