import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import "lenis/dist/lenis.css";
import { setAsciiThumbPalette, paletteForProvider } from "./landing-ascii-thumb";

gsap.registerPlugin(ScrollTrigger);

let lenis: Lenis | null = null;

function initLenis() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return null;

  const instance = new Lenis({
    // Lerp (not duration) — soft follow without the heavy, laggy glide.
    lerp: 0.12,
    smoothWheel: true,
    wheelMultiplier: 1,
    touchMultiplier: 1,
    syncTouch: false,
    anchors: true,
    autoRaf: true,
    // Keep page scroll uniform over the Safari mock (no nested scroll traps).
    allowNestedScroll: false,
  });

  instance.on("scroll", ScrollTrigger.update);
  // Keep GSAP's clock honest while Lenis owns the wheel.
  gsap.ticker.lagSmoothing(0);

  return instance;
}

function start() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  document.documentElement.classList.add("motion-ready");

  // Hero enter — intentional first-paint motion
  const hero = gsap.timeline({ defaults: { ease: "power3.out" } });
  hero
    .from(".hero-copy h1", { y: 36, opacity: 0, duration: 0.8 }, 0.08)
    .from(".hero-copy .lede", { y: 24, opacity: 0, duration: 0.65 }, 0.18)
    .from(".hero-copy .cta-row > *", { y: 18, opacity: 0, duration: 0.5, stagger: 0.08 }, 0.28)
    .from(".demo", { y: 48, opacity: 0, scale: 0.985, duration: 0.9 }, 0.24);

  // Section heads + blocks on scroll
  gsap.utils.toArray<HTMLElement>("[data-reveal]").forEach((el) => {
    gsap.from(el, {
      y: 40,
      opacity: 0,
      duration: 0.75,
      ease: "power3.out",
      scrollTrigger: {
        trigger: el,
        start: "top 88%",
        toggleActions: "play none none none",
      },
    });
  });

  gsap.utils.toArray<HTMLElement>("[data-stagger]").forEach((group) => {
    const kids = group.querySelectorAll(":scope > *");
    gsap.from(kids, {
      y: 28,
      opacity: 0,
      duration: 0.6,
      ease: "power3.out",
      stagger: 0.1,
      scrollTrigger: {
        trigger: group,
        start: "top 86%",
        toggleActions: "play none none none",
      },
    });
  });

  // Platform cascade lives in landing-platforms.ts (avoids double from→opacity:0)

  initHowFlow();
  initBuiltStack();
  initCommandsTerminal();
}

/**
 * How-it-works: live mini pipeline — chat link pulses, flies into queue,
 * queue advances into the stream player. Loops while in view.
 */
function initHowFlow() {
  const art = document.querySelector<HTMLElement>("#how .feature-art");
  const sceneEl = art?.querySelector<HTMLElement>("[data-how-scene]");
  if (!art || !sceneEl) return;
  const scene = sceneEl;

  const cols = scene.querySelectorAll<HTMLElement>("[data-how-col]");
  const arrows = scene.querySelectorAll<HTMLElement>("[data-how-arrow]");
  const feed = scene.querySelectorAll<HTMLElement>(".how-msg");
  const seed = scene.querySelector<HTMLElement>("[data-how-seed]");
  const slots = scene.querySelectorAll<HTMLElement>("[data-how-slot]");
  const empty = scene.querySelector<HTMLElement>("[data-how-slot-empty]");
  const player = scene.querySelector<HTMLElement>("[data-how-player]");
  const progress = scene.querySelector<HTMLElement>("[data-how-progress]");
  const title = scene.querySelector<HTMLElement>("[data-how-title]");
  const meta = scene.querySelector<HTMLElement>("[data-how-meta]");
  const screen = scene.querySelector<HTMLElement>(".how-screen");
  const playBtn = scene.querySelector<HTMLElement>(".how-play-btn");

  const fa = document.documentElement.lang === "fa";
  const arrowOrigin = fa ? "right center" : "left center";
  const flyLabel = fa ? "لینک" : "link";
  const clips = fa
    ? [
        { title: "خنده‌دارترین سوتی", meta: "یوتیوب · LowG", thumb: "youtube" },
        { title: "چت منفجر شد", meta: "توییچ · Amir", thumb: "twitch" },
        { title: "کلاچ دیوونه‌وار", meta: "کیک · Radin · ۰:۴۱", thumb: "kick" },
      ]
    : [
        { title: "Funniest fail", meta: "YouTube · LowG", thumb: "youtube" },
        { title: "Chat goes wild", meta: "Twitch · Amir", thumb: "twitch" },
        { title: "Insane clutch", meta: "Kick · Radin · 0:41", thumb: "kick" },
      ];

  gsap.set(cols, { opacity: 0, y: 28 });
  gsap.set(arrows, { opacity: 0, scaleX: 0, transformOrigin: arrowOrigin });
  gsap.set(feed, { opacity: 0, x: fa ? 10 : -10 });
  gsap.set(slots, { opacity: 0.25, y: 10 });
  if (empty) gsap.set(empty, { opacity: 0.45 });
  if (progress) gsap.set(progress, { scaleX: 0, transformOrigin: "left center" });
  if (playBtn) gsap.set(playBtn, { scale: 0.85, opacity: 0.7 });

  let clipIndex = 0;
  let loop: gsap.core.Timeline | null = null;

  const enter = gsap.timeline({
    scrollTrigger: {
      trigger: art,
      start: "top 78%",
      toggleActions: "play none none none",
      onEnter: () => {
        if (!loop) loop = buildLoop();
        loop.play(0);
      },
      onEnterBack: () => loop?.play(0),
      onLeave: () => loop?.pause(),
      onLeaveBack: () => loop?.pause(),
    },
  });

  enter
    .to(cols, { opacity: 1, y: 0, duration: 0.55, ease: "power3.out", stagger: 0.11 }, 0)
    .to(arrows, { opacity: 1, scaleX: 1, duration: 0.42, ease: "power2.out", stagger: 0.12 }, 0.18)
    .to(feed, { opacity: 1, x: 0, duration: 0.4, stagger: 0.08, ease: "power2.out" }, 0.28)
    .to(slots, { opacity: 1, y: 0, duration: 0.4, stagger: 0.08, ease: "power2.out" }, 0.38)
    .to(playBtn, { scale: 1, opacity: 1, duration: 0.35, ease: "back.out(1.6)" }, 0.55);

  function flyChip(fromEl: HTMLElement, toEl: HTMLElement, label: string) {
    const ghost = document.createElement("div");
    ghost.className = "how-fly";
    ghost.textContent = label;
    scene.append(ghost);

    const from = fromEl.getBoundingClientRect();
    const to = toEl.getBoundingClientRect();
    const box = scene.getBoundingClientRect();
    const x0 = from.left - box.left + from.width * 0.15;
    const y0 = from.top - box.top;
    const x1 = to.left - box.left + 10;
    const y1 = to.top - box.top + to.height * 0.2;
    const midX = (x0 + x1) / 2;
    const midY = Math.min(y0, y1) - 18;

    gsap.set(ghost, { left: x0, top: y0, opacity: 0, scale: 0.85 });
    gsap
      .timeline()
      .to(ghost, { opacity: 1, scale: 1, duration: 0.15, ease: "power1.out" })
      .to(ghost, {
        keyframes: [
          { left: midX, top: midY, scale: 1.05, duration: 0.35, ease: "power2.out" },
          { left: x1, top: y1, scale: 0.72, opacity: 0, duration: 0.4, ease: "power2.in" },
        ],
        onComplete: () => ghost.remove(),
      });
  }

  function buildLoop() {
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.5, paused: true });

    // 1) Chat link catches attention
    tl.to(seed, {
      keyframes: [
        { scale: 1.045, duration: 0.22, ease: "power1.out" },
        { scale: 1, duration: 0.28, ease: "power1.inOut" },
      ],
      onStart: () => seed?.classList.add("how-msg-pulse"),
      onComplete: () => seed?.classList.remove("how-msg-pulse"),
    });

    // 2) Arrow 1 blinks, chip flies into queue
    tl.to(
      arrows[0] ?? null,
      { opacity: 0.35, duration: 0.18, yoyo: true, repeat: 1, ease: "sine.inOut" },
      "-=0.1",
    );

    tl.add(() => {
      if (seed && slots[0]) flyChip(seed, slots[0], flyLabel);
    });

    tl.to({}, { duration: 0.7 });

    // 3) Queue receives the clip — soft settle
    tl.fromTo(
      slots[0] ?? null,
      { boxShadow: "0 0 0 0 transparent" },
      {
        boxShadow: "0 0 0 1px rgb(225 24 47 / 0.55)",
        duration: 0.22,
        yoyo: true,
        repeat: 1,
        ease: "power2.out",
      },
    );

    tl.to(slots, {
      y: -4,
      duration: 0.2,
      stagger: 0.05,
      yoyo: true,
      repeat: 1,
      ease: "power1.inOut",
    }, "-=0.15");

    // 4) Promote to stream
    tl.to(
      arrows[1] ?? null,
      { opacity: 0.35, duration: 0.18, yoyo: true, repeat: 1, ease: "sine.inOut" },
    );

    tl.add(() => {
      if (slots[0] && player) flyChip(slots[0], player, "▶");
    });

    tl.to({}, { duration: 0.55 });

    tl.add(() => {
      const clip = clips[clipIndex % clips.length]!;
      clipIndex++;
      if (title) title.textContent = clip.title;
      if (meta) meta.textContent = clip.meta;
      if (screen) {
        screen.className = `how-screen ${clip.thumb}`;
        setAsciiThumbPalette(screen, paletteForProvider(clip.thumb));
      }
    });

    tl.fromTo(
      player,
      { scale: 0.97, opacity: 0.75 },
      { scale: 1, opacity: 1, duration: 0.4, ease: "power3.out" },
    );

    tl.fromTo(
      playBtn,
      { scale: 0.7, opacity: 0.5 },
      { scale: 1, opacity: 1, duration: 0.35, ease: "back.out(2)" },
      "-=0.25",
    );

    // 5) Playback progress
    tl.fromTo(
      progress,
      { scaleX: 0 },
      { scaleX: 1, duration: 2.0, ease: "none" },
    );

    if (empty) {
      tl.to(empty, { opacity: 0.9, duration: 0.25 }, "-=0.6");
      tl.to(empty, { opacity: 0.45, duration: 0.35 });
    }

    return tl;
  }

  gsap.fromTo(
    scene,
    { y: 12 },
    {
      y: -12,
      ease: "none",
      scrollTrigger: {
        trigger: art,
        start: "top bottom",
        end: "bottom top",
        scrub: 0.7,
      },
    },
  );
}

/** Built-for-chat stack: staggered card entrance + light scrub depth. */
function initBuiltStack() {
  const art = document.querySelector<HTMLElement>("#built .feature-art");
  const stack = art?.querySelector<HTMLElement>(".art-stack");
  const cards = art?.querySelectorAll<HTMLElement>(".art-card");
  if (!art || !stack || !cards?.length) return;

  const tl = gsap.timeline({
    scrollTrigger: {
      trigger: art,
      start: "top 80%",
      toggleActions: "play none none none",
    },
  });

  tl.from(cards, {
    x: 40,
    opacity: 0,
    duration: 0.58,
    ease: "power3.out",
    stagger: 0.13,
  });

  gsap.fromTo(
    stack,
    { y: 16 },
    {
      y: -16,
      ease: "none",
      scrollTrigger: {
        trigger: art,
        start: "top bottom",
        end: "bottom top",
        scrub: 0.7,
      },
    },
  );
}

/** Commands terminal: staged window + line reveal. */
function initCommandsTerminal() {
  const art = document.querySelector<HTMLElement>("#commands .feature-art");
  const terminal = art?.querySelector<HTMLElement>(".art-terminal");
  if (!art || !terminal) return;

  const dots = terminal.querySelectorAll(".art-terminal-bar span");
  const muted = terminal.querySelector(".art-cmd-muted");
  const lines = terminal.querySelectorAll(".art-cmd-line, .art-cmd-ok");

  const tl = gsap.timeline({
    scrollTrigger: {
      trigger: art,
      start: "top 78%",
      toggleActions: "play none none none",
    },
  });

  // Opacity/scale enter — leave `y` free for scrub parallax (no fighting tweens)
  tl.from(terminal, {
    opacity: 0,
    scale: 0.97,
    duration: 0.7,
    ease: "power3.out",
  })
    .from(
      dots,
      {
        scale: 0,
        opacity: 0,
        duration: 0.28,
        ease: "back.out(1.6)",
        stagger: 0.06,
      },
      "-=0.35",
    );

  if (muted) {
    tl.from(
      muted,
      { opacity: 0, y: 6, duration: 0.35, ease: "power2.out" },
      "-=0.1",
    );
  }

  tl.from(
    lines,
    {
      opacity: 0,
      y: 10,
      duration: 0.4,
      ease: "power2.out",
      stagger: 0.14,
    },
    "-=0.05",
  );

  gsap.fromTo(
    terminal,
    { y: 12 },
    {
      y: -12,
      ease: "none",
      scrollTrigger: {
        trigger: art,
        start: "top bottom",
        end: "bottom top",
        scrub: 0.7,
      },
    },
  );
}

lenis = initLenis();
start();

function syncHeaderScroll() {
  const header = document.querySelector(".site-header");
  if (!header) return;
  const onScroll = () => {
    const y = lenis?.scroll ?? window.scrollY;
    header.classList.toggle("is-scrolled", y > 8);
  };
  onScroll();
  if (lenis) lenis.on("scroll", onScroll);
  else window.addEventListener("scroll", onScroll, { passive: true });
}

syncHeaderScroll();
