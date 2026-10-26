// Renders the Open Graph preview image: node scripts/og.mjs  ->  src/web/public/og.png (1200x630).
// Uses system fonts (written on macOS: Avenir Next + Geeza Pro). Rerun only when the design changes;
// the PNG is committed.

import { Resvg } from "@resvg/resvg-js";
import { writeFileSync } from "node:fs";

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="glow" cx="88%" cy="0%" r="75%">
      <stop offset="0" stop-color="#e1182f" stop-opacity="0.42"/>
      <stop offset="1" stop-color="#e1182f" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow2" cx="0%" cy="100%" r="60%">
      <stop offset="0" stop-color="#7a0b17" stop-opacity="0.5"/>
      <stop offset="1" stop-color="#7a0b17" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="player" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3a0d14"/>
      <stop offset="0.6" stop-color="#120708"/>
    </linearGradient>
  </defs>

  <rect width="1200" height="630" fill="#0a0a0a"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <rect width="1200" height="630" fill="url(#glow2)"/>

  <!-- brand -->
  <rect x="80" y="92" width="26" height="26" rx="6" fill="#e1182f"/>
  <text x="122" y="117" font-family="Avenir Next" font-weight="700" font-size="40" fill="#f6ead9">clipQ</text>

  <!-- headline -->
  <text font-family="Avenir Next" font-weight="700" font-size="68" fill="#f6ead9" letter-spacing="-1.5">
    <tspan x="80" y="250">The clip queue</tspan>
    <tspan x="80" y="330">for <tspan fill="#e1182f">Kick</tspan> streamers</tspan>
  </text>
  <text x="80" y="400" font-family="Avenir Next" font-weight="500" font-size="28" fill="#cfc2af">
    Chat posts the links. You watch them in order.
  </text>
  <text x="80" y="452" font-family="Geeza Pro" font-weight="700" font-size="30" fill="#cfc2af" direction="rtl" text-anchor="start">
    صف کلیپ برای استریمرهای کیک
  </text>

  <!-- pills -->
  <g font-family="Avenir Next" font-weight="700" font-size="20" fill="#f6ead9">
    <rect x="80" y="510" width="96" height="44" rx="22" fill="#1c0b0e" stroke="#a34946" stroke-opacity="0.6"/>
    <text x="128" y="539" text-anchor="middle">Kick</text>
    <rect x="188" y="510" width="128" height="44" rx="22" fill="#1c0b0e" stroke="#a34946" stroke-opacity="0.6"/>
    <text x="252" y="539" text-anchor="middle">YouTube</text>
    <rect x="328" y="510" width="112" height="44" rx="22" fill="#1c0b0e" stroke="#a34946" stroke-opacity="0.6"/>
    <text x="384" y="539" text-anchor="middle">Twitch</text>
    <rect x="452" y="510" width="112" height="44" rx="22" fill="#1c0b0e" stroke="#a34946" stroke-opacity="0.6"/>
    <text x="508" y="539" text-anchor="middle">TikTok</text>
    <rect x="576" y="510" width="96" height="44" rx="22" fill="#d3162c"/>
    <text x="624" y="539" text-anchor="middle">Free</text>
  </g>

  <!-- product mock -->
  <g transform="translate(760 150)">
    <rect width="370" height="340" rx="18" fill="#111111" stroke="#a34946" stroke-opacity="0.45"/>
    <rect x="18" y="18" width="334" height="170" rx="12" fill="url(#player)"/>
    <path d="M172 82 l32 21 -32 21 z" fill="#f6ead9" fill-opacity="0.9"/>
    <g font-family="Avenir Next" font-size="17">
      <rect x="18" y="204" width="334" height="54" rx="10" fill="#1c0b0e"/>
      <rect x="30" y="215" width="56" height="32" rx="6" fill="#2c1110"/>
      <text x="100" y="230" font-weight="700" fill="#f6ead9">1. Funniest fail of the week</text>
      <text x="100" y="250" font-size="14" fill="#cfc2af">YouTube · LowGraphic</text>
      <rect x="18" y="268" width="334" height="54" rx="10" fill="#1c0b0e"/>
      <rect x="30" y="279" width="56" height="32" rx="6" fill="#2c1110"/>
      <text x="100" y="294" font-weight="700" fill="#f6ead9">2. Chat goes wild</text>
      <text x="100" y="314" font-size="14" fill="#cfc2af">Twitch · Amir_1446</text>
    </g>
  </g>
</svg>`;

const png = new Resvg(svg, {
  fitTo: { mode: "width", value: 1200 },
  font: { loadSystemFonts: true, defaultFontFamily: "Avenir Next" },
}).render().asPng();

const out = new URL("../src/web/public/og.png", import.meta.url);
writeFileSync(out, png);
console.log(`wrote ${out.pathname} (${png.length} bytes)`);
