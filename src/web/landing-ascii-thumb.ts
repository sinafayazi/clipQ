// Lightweight GradientASCII-inspired fill for mock YouTube/Twitch/Kick thumbs.
// Canvas 2D — sized for 16:9 landing thumbnails.

const CHARS = " ·-=+*#%@";

export type AsciiPalette = readonly string[];

/** Dark, distinct brand-tinted ramps (dim → bright). */
export const ASCII_PALETTES = {
  youtube: ["#1a080c", "#3d1018", "#6b1824", "#9a2a38", "#c45a62"] as const,
  twitch: ["#0c0818", "#1a1230", "#2a1f4a", "#4a3a72", "#7a6a9a"] as const,
  kick: ["#06140a", "#0c2412", "#163a1c", "#2a5a30", "#4a7a48"] as const,
  red: ["#14080a", "#2a1014", "#4a1820", "#6e2830", "#8a4a50"] as const,
  slate: ["#0a0c10", "#141820", "#222830", "#3a4250", "#5a6470"] as const,
  ember: ["#120a06", "#24140c", "#3a2010", "#5a3418", "#7a4a28"] as const,
  wine: ["#100810", "#201018", "#381828", "#502038", "#6a3850"] as const,
} as const;

export type AsciiKind = keyof typeof ASCII_PALETTES;

type Handle = { destroy: () => void; setPalette: (p: AsciiPalette) => void };

const live = new WeakMap<HTMLElement, Handle>();

export function mountAsciiThumb(
  host: HTMLElement,
  variation = 0,
  palette: AsciiPalette = ASCII_PALETTES.youtube,
): void {
  live.get(host)?.destroy();

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const canvas = document.createElement("canvas");
  canvas.className = "ascii-thumb-canvas";
  canvas.setAttribute("aria-hidden", "true");
  host.prepend(canvas);

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  let colors: AsciiPalette = palette;
  let w = 0;
  let h = 0;
  let raf = 0;
  let running = true;
  let visible = true;
  const seed = 1.7 + variation * 0.37;
  const t0 = performance.now();

  const resize = () => {
    const rect = host.getBoundingClientRect();
    w = Math.max(1, Math.floor(rect.width));
    h = Math.max(1, Math.floor(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paint(reduced ? 0 : (performance.now() - t0) / 1000);
  };

  const paint = (time: number) => {
    ctx.fillStyle = "#050505";
    ctx.fillRect(0, 0, w, h);

    const cell = Math.max(5, Math.min(10, Math.floor(h / 6)));
    const cols = Math.ceil(w / cell) + 1;
    const rows = Math.ceil(h / cell) + 1;
    ctx.font = `${Math.floor(cell * 0.85)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const u = x / cols;
        const v = y / rows;
        const wave = 0.5 + 0.5 * Math.sin(u * 6.2 + time * 0.7 + seed);
        const field = Math.pow(Math.max(0, 1.15 - v * 1.35 + wave * 0.22 * (1 - v)), 1.35);
        const grain = hash(x + seed * 10, y + seed * 3) * 0.12;
        const bright = Math.min(1, Math.max(0, field + grain - 0.08));
        if (bright < 0.08) continue;

        const ci = Math.min(colors.length - 1, Math.floor(bright * (colors.length - 0.001)));
        const gi = Math.min(CHARS.length - 1, Math.floor(bright * (CHARS.length - 0.001)));
        let ch = CHARS[gi]!;
        if (!reduced && hash(x * 3 + time * 2, y) > 0.92) {
          ch = CHARS[Math.min(CHARS.length - 1, gi + 1)]!;
        }

        ctx.globalAlpha = 0.4 + bright * 0.55;
        ctx.fillStyle = colors[ci]!;
        ctx.fillText(ch, x * cell + cell * 0.5, y * cell + cell * 0.55);
      }
    }
    ctx.globalAlpha = 1;
  };

  const tick = (now: number) => {
    if (!running) return;
    if (visible && !reduced) paint((now - t0) / 1000);
    raf = requestAnimationFrame(tick);
  };

  resize();
  if (!reduced) raf = requestAnimationFrame(tick);

  const ro = new ResizeObserver(resize);
  ro.observe(host);

  const io = new IntersectionObserver(([entry]) => {
    visible = !!entry?.isIntersecting;
    if (visible && !reduced && !raf) raf = requestAnimationFrame(tick);
    if (!visible && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  });
  io.observe(host);

  const handle: Handle = {
    destroy: () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      ro.disconnect();
      io.disconnect();
      canvas.remove();
      live.delete(host);
    },
    setPalette: (p) => {
      colors = p;
      paint(reduced ? 0 : (performance.now() - t0) / 1000);
    },
  };
  live.set(host, handle);
}

export function unmountAsciiThumb(host: HTMLElement): void {
  live.get(host)?.destroy();
}

export function setAsciiThumbPalette(host: HTMLElement, palette: AsciiPalette): void {
  const h = live.get(host);
  if (h) h.setPalette(palette);
  else mountAsciiThumb(host, 0, palette);
}

export function paletteForProvider(provider: string): AsciiPalette {
  if (provider === "twitch") return ASCII_PALETTES.twitch;
  if (provider === "kick") return ASCII_PALETTES.kick;
  if (provider === "youtube") return ASCII_PALETTES.youtube;
  return ASCII_PALETTES.slate;
}

/** Mount ASCII on how-it-works + built-for-chat thumbs already in the DOM. */
export function mountHowAsciiThumbs(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>(".how-q-thumb, .art-thumb, .how-screen").forEach((el, i) => {
    const kind = el.classList.contains("twitch")
      ? "twitch"
      : el.classList.contains("kick")
        ? "kick"
        : el.classList.contains("youtube")
          ? "youtube"
          : "slate";
    mountAsciiThumb(el, i + 4, ASCII_PALETTES[kind]);
  });
}

function hash(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => mountHowAsciiThumbs());
  } else {
    mountHowAsciiThumbs();
  }
}
