import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

const MAX_TILT = 9;
const MAX_SHIFT = 5;
const MAX_ICON = 7;

type CardFx = {
  el: HTMLElement;
  setRotX: ReturnType<typeof gsap.quickTo>;
  setRotY: ReturnType<typeof gsap.quickTo>;
  setX: ReturnType<typeof gsap.quickTo>;
  setY: ReturnType<typeof gsap.quickTo>;
  setIconX: ((v: number) => void) | null;
  setIconY: ((v: number) => void) | null;
};

function start() {
  const grid = document.querySelector<HTMLElement>(".platform-grid");
  if (!grid) return;

  const marks = gsap.utils.toArray<HTMLElement>(".platform-mark", grid);
  if (!marks.length) return;

  // Reduced motion: leave static markup + CSS hover only.
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  // landing-motion.ts also gsap.from()'s these marks. A second from() with
  // immediateRender records opacity:0 as the end state → stuck invisible.
  gsap.killTweensOf(marks);
  ScrollTrigger.getAll().forEach((st) => {
    const trigger = st.trigger;
    if (
      trigger instanceof Element &&
      (trigger.id === "sources" || trigger === grid || grid.contains(trigger))
    ) {
      st.kill();
    }
  });
  gsap.set(marks, { autoAlpha: 1, y: 0, scale: 1 });

  gsap.fromTo(
    marks,
    { y: 28, autoAlpha: 0, scale: 0.92 },
    {
      y: 0,
      autoAlpha: 1,
      scale: 1,
      duration: 0.6,
      ease: "power3.out",
      stagger: 0.07,
      immediateRender: false,
      overwrite: "auto",
      scrollTrigger: {
        trigger: "#sources",
        start: "top 78%",
        toggleActions: "play none none none",
        // If the section is already past the start line (deep link / refresh),
        // still land at full opacity instead of leaving from-values applied.
        onRefresh(self) {
          if (self.progress > 0 || self.isActive) {
            gsap.set(marks, { autoAlpha: 1, y: 0, scale: 1 });
          }
        },
      },
      onComplete() {
        gsap.set(marks, { clearProps: "opacity,visibility" });
      },
    },
  );

  if (!matchMedia("(hover: hover) and (pointer: fine)").matches) return;

  grid.classList.add("platforms-live");

  const cards: CardFx[] = marks.map((el) => {
    const icon = el.querySelector<HTMLElement>(".platform-icon");
    gsap.set(el, {
      transformPerspective: 560,
      transformOrigin: "50% 50%",
      force3D: true,
    });
    if (icon) gsap.set(icon, { force3D: true });

    return {
      el,
      setRotX: gsap.quickTo(el, "rotationX", { duration: 0.32, ease: "power3.out" }),
      setRotY: gsap.quickTo(el, "rotationY", { duration: 0.32, ease: "power3.out" }),
      setX: gsap.quickTo(el, "x", { duration: 0.38, ease: "power3.out" }),
      setY: gsap.quickTo(el, "y", { duration: 0.38, ease: "power3.out" }),
      setIconX: icon
        ? gsap.quickTo(icon, "x", { duration: 0.28, ease: "power3.out" })
        : null,
      setIconY: icon
        ? gsap.quickTo(icon, "y", { duration: 0.28, ease: "power3.out" })
        : null,
    };
  });

  const reset = () => {
    for (const card of cards) {
      card.setRotX(0);
      card.setRotY(0);
      card.setX(0);
      card.setY(0);
      card.setIconX?.(0);
      card.setIconY?.(0);
    }
  };

  const onMove = (e: PointerEvent) => {
    for (const card of cards) {
      const rect = card.el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      // Normalize with padding so neighbors still react softly.
      const nx = gsap.utils.clamp(-1, 1, (e.clientX - cx) / (rect.width * 0.5 + 72));
      const ny = gsap.utils.clamp(-1, 1, (e.clientY - cy) / (rect.height * 0.5 + 72));
      const falloff = Math.max(0, 1 - Math.hypot(nx, ny) * 0.42);

      card.setRotY(nx * MAX_TILT * falloff);
      card.setRotX(-ny * MAX_TILT * falloff);
      card.setX(nx * MAX_SHIFT * falloff);
      card.setY(ny * MAX_SHIFT * falloff);
      card.setIconX?.(nx * MAX_ICON * falloff);
      card.setIconY?.(ny * MAX_ICON * falloff);
    }
  };

  grid.addEventListener("pointermove", onMove);
  grid.addEventListener("pointerleave", reset);
}

start();
