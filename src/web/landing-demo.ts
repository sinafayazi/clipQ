// Animated example on the landing pages: chat messages arrive, links among them become queue cards.
// The HTML already contains a finished static frame (for no-JS, crawlers and reduced motion);
// this script only replays it as an animation.

type Provider = "kick" | "youtube" | "twitch" | "tiktok";

interface Line {
  user: string;
  color: string;
  text: string;
  clip?: { title: string; provider: Provider; duration: string };
}

const LABEL: Record<Provider, string> = { kick: "Kick", youtube: "YouTube", twitch: "Twitch", tiktok: "TikTok" };
const LABEL_FA: Record<Provider, string> = { kick: "کیک", youtube: "یوتیوب", twitch: "توییچ", tiktok: "تیک‌تاک" };

const SCRIPT: Record<"en" | "fa", Line[]> = {
  en: [
    { user: "Radin_SD", color: "#ffa600", text: "W stream today" },
    { user: "LowGraphic", color: "#00f1ff", text: "youtu.be/xK2…", clip: { title: "Funniest fail of the week", provider: "youtube", duration: "0:58" } },
    { user: "Amir_1446", color: "#b388ff", text: "LMAO" },
    { user: "Amir_1446", color: "#b388ff", text: "kick.com/…/clips/clip_01K…", clip: { title: "Insane clutch, final round", provider: "kick", duration: "0:41" } },
    { user: "Mahsa", color: "#ff6b9a", text: "play mine next pls" },
    { user: "Mahsa", color: "#ff6b9a", text: "clips.twitch.tv/Wild…", clip: { title: "Chat goes wild", provider: "twitch", duration: "0:30" } },
    { user: "Siiinfa", color: "#53fc18", text: "tiktok.com/@…/video/73…", clip: { title: "Cat vs printer", provider: "tiktok", duration: "0:22" } },
  ],
  fa: [
    { user: "Radin_SD", color: "#ffa600", text: "استریم امروز عالیه" },
    { user: "LowGraphic", color: "#00f1ff", text: "youtu.be/xK2…", clip: { title: "خنده‌دارترین سوتی هفته", provider: "youtube", duration: "۰:۵۸" } },
    { user: "Amir_1446", color: "#b388ff", text: "😂😂😂" },
    { user: "Amir_1446", color: "#b388ff", text: "kick.com/…/clips/clip_01K…", clip: { title: "کلاچ دیوونه‌وار راند آخر", provider: "kick", duration: "۰:۴۱" } },
    { user: "Mahsa", color: "#ff6b9a", text: "بعدی مال منو بذار" },
    { user: "Mahsa", color: "#ff6b9a", text: "clips.twitch.tv/Wild…", clip: { title: "چت منفجر شد", provider: "twitch", duration: "۰:۳۰" } },
    { user: "Siiinfa", color: "#53fc18", text: "tiktok.com/@…/video/73…", clip: { title: "گربه در برابر پرینتر", provider: "tiktok", duration: "۰:۲۲" } },
  ],
};

const MAX_CHAT = 6;
const MAX_QUEUE = 3;
const STEP_MS = 1700;

function start() {
  const chat = document.getElementById("demo-chat");
  const queue = document.getElementById("demo-queue");
  const now = document.getElementById("demo-now");
  if (!chat || !queue || !now) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return; // keep the static frame

  const fa = document.documentElement.lang === "fa";
  const lines = SCRIPT[fa ? "fa" : "en"];
  const labels = fa ? LABEL_FA : LABEL;
  const by = fa ? "درخواست از" : "requested by";

  chat.replaceChildren();
  queue.replaceChildren();
  let i = 0;

  const tick = () => {
    const line = lines[i % lines.length]!;
    i++;

    const li = document.createElement("li");
    li.className = "chat-line enter";
    const name = document.createElement("b");
    name.style.color = line.color;
    name.textContent = line.user;
    const text = document.createElement("span");
    text.textContent = line.text;
    if (line.clip) text.className = "chat-link";
    text.dir = line.clip ? "ltr" : "auto";
    li.append(name, text);
    chat.append(li);
    while (chat.children.length > MAX_CHAT) chat.firstElementChild!.remove();

    if (line.clip) {
      const clip = line.clip;
      window.setTimeout(() => {
        // Queue full: the first card moves up to "now playing".
        if (queue.children.length >= MAX_QUEUE) {
          const first = queue.firstElementChild as HTMLElement;
          setNowPlaying(now, first.dataset.provider as Provider, first.dataset.title!, first.dataset.meta!);
          first.remove();
        }
        queue.append(card(clip, `${labels[clip.provider]} · ${line.user}`, `${labels[clip.provider]} · ${by} ${line.user} · ${clip.duration}`));
      }, 650);
    }
  };

  tick();
  window.setInterval(tick, STEP_MS);
}

function card(clip: NonNullable<Line["clip"]>, meta: string, nowMeta: string) {
  const li = document.createElement("li");
  li.className = "demo-card enter";
  li.dataset.provider = clip.provider;
  li.dataset.title = clip.title;
  li.dataset.meta = nowMeta;
  li.innerHTML = `<span class="demo-thumb ${clip.provider}"><span class="dur"></span></span><span class="demo-card-text"><b></b><small></small></span>`;
  li.querySelector(".dur")!.textContent = clip.duration;
  li.querySelector("b")!.textContent = clip.title;
  li.querySelector("small")!.textContent = meta;
  return li;
}

function setNowPlaying(now: HTMLElement, provider: Provider, title: string, meta: string) {
  const screen = now.querySelector(".demo-screen") as HTMLElement;
  screen.className = `demo-screen ${provider}`;
  now.querySelector(".demo-now-title")!.textContent = title;
  now.querySelector(".demo-now-meta")!.textContent = meta;
  // Restart the progress bar.
  const bar = now.querySelector(".demo-progress") as HTMLElement;
  bar.classList.remove("run");
  void bar.offsetWidth;
  bar.classList.add("run");
}

start();
