import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import "lenis/dist/lenis.css";

gsap.registerPlugin(ScrollTrigger);

const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

function initLenis() {
  if (reduce) return null;
  const instance = new Lenis({
    lerp: 0.12,
    smoothWheel: true,
    wheelMultiplier: 1,
    touchMultiplier: 1,
    syncTouch: false,
    anchors: true,
    autoRaf: true,
  });
  instance.on("scroll", ScrollTrigger.update);
  gsap.ticker.lagSmoothing(0);
  return instance;
}

function splitTitle(el: HTMLElement) {
  const text = el.textContent?.trim() ?? "";
  el.setAttribute("aria-label", text);
  el.textContent = "";
  for (const ch of text) {
    const span = document.createElement("span");
    span.className = "char";
    span.textContent = ch === " " ? "\u00a0" : ch;
    span.setAttribute("aria-hidden", "true");
    el.append(span);
  }
}

function initHeader() {
  const header = document.querySelector<HTMLElement>(".site-header");
  if (!header) return;
  const onScroll = () => header.classList.toggle("is-scrolled", scrollY > 12);
  onScroll();
  addEventListener("scroll", onScroll, { passive: true });
}

function initProgress() {
  const bar = document.querySelector<HTMLElement>("[data-progress]");
  if (!bar) return;
  ScrollTrigger.create({
    start: 0,
    end: "max",
    onUpdate: (self) => {
      bar.style.width = `${(self.progress * 100).toFixed(2)}%`;
    },
  });
}

function initRail() {
  const links = [...document.querySelectorAll<HTMLAnchorElement>("[data-rail-link]")];
  if (!links.length) return;

  const setActive = (id: string) => {
    for (const link of links) {
      link.classList.toggle("is-active", link.dataset.railLink === id);
    }
  };

  for (const section of document.querySelectorAll<HTMLElement>("[data-section]")) {
    const id = section.dataset.section;
    if (!id) continue;
    ScrollTrigger.create({
      trigger: section,
      start: "top center",
      end: "bottom center",
      onEnter: () => setActive(id),
      onEnterBack: () => setActive(id),
    });
  }
  setActive("clips");
}

function initCopy() {
  const toast = document.querySelector<HTMLElement>("[data-toast]");
  let toastTimer = 0;

  const showToast = () => {
    if (!toast) return;
    toast.hidden = false;
    gsap.fromTo(toast, { y: 12, opacity: 0 }, { y: 0, opacity: 1, duration: 0.28, ease: "power2.out" });
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      gsap.to(toast, {
        y: 8,
        opacity: 0,
        duration: 0.22,
        ease: "power2.in",
        onComplete: () => {
          toast.hidden = true;
        },
      });
    }, 1400);
  };

  for (const btn of document.querySelectorAll<HTMLButtonElement>(".help-cmd[data-copy]")) {
    btn.addEventListener("click", async () => {
      const value = btn.dataset.copy ?? "";
      try {
        await navigator.clipboard.writeText(value.trimEnd());
      } catch {
        /* clipboard may be blocked; still show feedback for the attempt */
      }
      btn.classList.add("is-copied");
      showToast();
      window.setTimeout(() => btn.classList.remove("is-copied"), 900);
    });
  }
}

function initMagneticRows() {
  if (reduce || !matchMedia("(hover: hover)").matches) return;

  for (const btn of document.querySelectorAll<HTMLElement>("button.help-cmd")) {
    const onMove = (e: PointerEvent) => {
      const rect = btn.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width - 0.5;
      gsap.to(btn, { x: x * 10, duration: 0.35, ease: "power2.out", overwrite: "auto" });
    };
    const onLeave = () => {
      gsap.to(btn, { x: 0, duration: 0.45, ease: "power3.out", overwrite: "auto" });
    };
    btn.addEventListener("pointermove", onMove);
    btn.addEventListener("pointerleave", onLeave);
  }
}

function initReveals() {
  gsap.utils.toArray<HTMLElement>("[data-reveal]").forEach((el) => {
    gsap.from(el, {
      y: 36,
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
    const kids = group.querySelectorAll(":scope > li");
    gsap.from(kids, {
      y: 22,
      opacity: 0,
      duration: 0.55,
      ease: "power3.out",
      stagger: 0.045,
      scrollTrigger: {
        trigger: group,
        start: "top 86%",
        toggleActions: "play none none none",
      },
    });
  });
}

function initHero() {
  const title = document.querySelector<HTMLElement>("[data-split]");
  if (title) splitTitle(title);

  if (reduce) return;

  document.documentElement.classList.add("motion-ready");

  const chars = title?.querySelectorAll(".char") ?? [];
  const items = document.querySelectorAll("[data-hero-item]");

  const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
  tl.from(chars, { y: 56, opacity: 0, rotateX: -40, duration: 0.85, stagger: 0.045, transformOrigin: "50% 100%" }, 0.06).from(
    items,
    { y: 22, opacity: 0, duration: 0.6, stagger: 0.08 },
    0.28,
  );
}

function start() {
  initHeader();
  initCopy();
  if (reduce) return;

  initLenis();
  initHero();
  initProgress();
  initRail();
  initReveals();
  initMagneticRows();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
