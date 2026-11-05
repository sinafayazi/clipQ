// Interactive /app-style dashboard preview in the hero.
// YouTube thumbs/screens use ASCII gradient fills; titles stay real. Static HTML is the no-JS frame.
// Demo chrome and content are always English (including on /fa/).

import {
  ASCII_PALETTES,
  mountAsciiThumb,
  setAsciiThumbPalette,
  type AsciiPalette,
} from "./landing-ascii-thumb";

type Tab = "clips" | "songs";
type Tone = "a" | "b" | "c" | "d";

interface Clip {
  id: string;
  title: string;
  /** Shown in meta (YouTube for clips; omitted for songs). */
  source: string;
  tone: Tone;
  user: string;
  duration: string;
}

const CLIPS: Clip[] = [
  {
    id: "c1",
    title: "Me at the zoo",
    source: "YouTube",
    tone: "a",
    user: "jawed",
    duration: "0:19",
  },
  {
    id: "c2",
    title: "Big Buck Bunny",
    source: "YouTube",
    tone: "b",
    user: "Blender",
    duration: "10:34",
  },
  {
    id: "c3",
    title: "Sintel trailer",
    source: "YouTube",
    tone: "c",
    user: "Blender",
    duration: "0:52",
  },
  {
    id: "c4",
    title: "Elephants Dream",
    source: "YouTube",
    tone: "d",
    user: "Blender",
    duration: "10:54",
  },
];

const SONGS: Clip[] = [
  {
    id: "s1",
    title: "Midnight City — M83",
    source: "YouTube",
    tone: "c",
    user: "Mahsa",
    duration: "4:04",
  },
  {
    id: "s2",
    title: "Blinding Lights — The Weeknd",
    source: "YouTube",
    tone: "a",
    user: "LowGraphic",
    duration: "3:23",
  },
  {
    id: "s3",
    title: "After Dark — Mr.Kitty",
    source: "YouTube",
    tone: "d",
    user: "Radin_SD",
    duration: "4:19",
  },
];

const copy = {
  clipsOpen: "Clips open",
  songsOpen: "Songs open",
  queue: "Queue",
  songs: "Songs",
  none: "None waiting",
  waiting: (n: number) => `${n} waiting`,
  by: "requested by",
  clipsEmptyOpen: "Clips show up here when viewers post links in chat.",
  clipsEmptyClosed: "Open the queue to accept clips from chat.",
  songsEmptyOpen: "Songs show up here when viewers type !sr in chat.",
  songsEmptyClosed: "Turn on Songs open to take songs from chat.",
  waitingClips: "Waiting for clips",
  waitingSongs: "Waiting for songs",
  queueClosed: "Queue is closed",
  songsClosed: "Song requests are closed",
  prev: "Previous",
  skip: "Skip",
  next: "Next",
};

function start() {
  const rootEl = document.querySelector<HTMLElement>("[data-demo]");
  if (!rootEl) return;
  const root = rootEl;

  const state = {
    tab: "clips" as Tab,
    clipsOpen: true,
    songsOpen: true,
    clips: {
      current: CLIPS[0]! as Clip | null,
      queue: CLIPS.slice(1),
      history: [] as Clip[],
    },
    songs: {
      current: SONGS[0]! as Clip | null,
      queue: SONGS.slice(1),
      history: [] as Clip[],
    },
  };

  const tabs = root.querySelectorAll<HTMLButtonElement>("[data-demo-tab]");
  const openInput = root.querySelector<HTMLInputElement>("[data-demo-open]");
  const openLabel = root.querySelector<HTMLElement>("[data-demo-open-label]");
  const queueHeading = root.querySelector<HTMLElement>("[data-demo-queue-heading]");
  const queueCount = root.querySelector<HTMLElement>("[data-demo-queue-count]");
  const queueList = root.querySelector<HTMLElement>("[data-demo-queue]");
  const screen = root.querySelector<HTMLElement>("[data-demo-screen]");
  const progress = root.querySelector<HTMLElement>("[data-demo-progress]");
  const emptyEl = root.querySelector<HTMLElement>("[data-demo-empty]");
  const emptyTitle = root.querySelector<HTMLElement>("[data-demo-empty-title]");
  const emptyBody = root.querySelector<HTMLElement>("[data-demo-empty-body]");
  const nowEl = root.querySelector<HTMLElement>("[data-demo-now]");
  const titleEl = root.querySelector<HTMLElement>("[data-demo-title]");
  const metaEl = root.querySelector<HTMLElement>("[data-demo-meta]");
  const prevBtn = root.querySelector<HTMLButtonElement>("[data-demo-prev]");
  const skipBtn = root.querySelector<HTMLButtonElement>("[data-demo-skip]");
  const nextBtn = root.querySelector<HTMLButtonElement>("[data-demo-next]");

  if (prevBtn) prevBtn.textContent = copy.prev;
  if (skipBtn) skipBtn.textContent = copy.skip;
  if (nextBtn) nextBtn.textContent = copy.next;

  tabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.demoTab as Tab;
      if (tab !== "clips" && tab !== "songs") return;
      state.tab = tab;
      render();
      restartProgress();
    });
  });

  openInput?.addEventListener("change", () => {
    if (state.tab === "clips") state.clipsOpen = !!openInput.checked;
    else state.songsOpen = !!openInput.checked;
    render();
  });

  prevBtn?.addEventListener("click", () => {
    const lane = laneState();
    const prev = lane.history.pop();
    if (!prev) return;
    if (lane.current) lane.queue.unshift(lane.current);
    lane.current = prev;
    render();
    restartProgress();
  });

  skipBtn?.addEventListener("click", () => advance(true));
  nextBtn?.addEventListener("click", () => advance(false));

  progress?.addEventListener("transitionend", (e) => {
    if (e.propertyName !== "width") return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    advance(false);
  });

  function laneState() {
    return state.tab === "clips" ? state.clips : state.songs;
  }

  function advance(skip: boolean) {
    const lane = laneState();
    if (!lane.current && !lane.queue.length) return;
    if (lane.current && !skip) lane.history.push(lane.current);
    lane.current = lane.queue.shift() ?? null;
    render();
    restartProgress();
  }

  function playFromQueue(id: string) {
    const lane = laneState();
    const i = lane.queue.findIndex((c) => c.id === id);
    if (i < 0) return;
    const [picked] = lane.queue.splice(i, 1);
    if (!picked) return;
    if (lane.current) lane.queue.unshift(lane.current);
    lane.current = picked;
    render();
    restartProgress();
  }

  function restartProgress() {
    if (!progress) return;
    progress.classList.remove("run");
    void progress.offsetWidth;
    if (laneState().current && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      progress.classList.add("run");
    }
  }

  function metaOf(c: Clip) {
    if (state.tab === "songs") return `${c.user} · ${c.duration}`;
    return `${c.source} · ${copy.by} ${c.user} · ${c.duration}`;
  }

  function render() {
    const lane = laneState();
    const open = state.tab === "clips" ? state.clipsOpen : state.songsOpen;

    root.dataset.theme = state.tab === "songs" ? "songs" : "";

    tabs.forEach((btn) => {
      const on = btn.dataset.demoTab === state.tab;
      btn.setAttribute("aria-selected", on ? "true" : "false");
      const count = btn.querySelector("[data-demo-tab-count]");
      if (count) {
        const len = btn.dataset.demoTab === "clips" ? state.clips.queue.length : state.songs.queue.length;
        count.textContent = String(len);
      }
    });

    if (openInput) openInput.checked = open;
    if (openLabel) openLabel.textContent = state.tab === "clips" ? copy.clipsOpen : copy.songsOpen;
    if (queueHeading) queueHeading.textContent = state.tab === "clips" ? copy.queue : copy.songs;
    if (queueCount) {
      queueCount.textContent = lane.queue.length === 0 ? copy.none : copy.waiting(lane.queue.length);
    }

    if (prevBtn) prevBtn.disabled = lane.history.length === 0;
    if (skipBtn) skipBtn.disabled = !lane.current;
    if (nextBtn) nextBtn.disabled = !lane.current && lane.queue.length === 0;

    if (lane.current) {
      emptyEl?.setAttribute("hidden", "");
      screen?.removeAttribute("hidden");
      nowEl?.removeAttribute("hidden");
      if (screen) {
        screen.className = `demo-screen tone-${lane.current.tone}`;
        setAsciiThumbPalette(screen, paletteForTone(lane.current.tone));
      }
      if (titleEl) titleEl.textContent = lane.current.title;
      if (metaEl) metaEl.textContent = metaOf(lane.current);
    } else {
      screen?.setAttribute("hidden", "");
      nowEl?.setAttribute("hidden", "");
      emptyEl?.removeAttribute("hidden");
      if (emptyTitle) {
        emptyTitle.textContent = open
          ? state.tab === "clips"
            ? copy.waitingClips
            : copy.waitingSongs
          : state.tab === "clips"
            ? copy.queueClosed
            : copy.songsClosed;
      }
      if (emptyBody) {
        emptyBody.textContent = open
          ? state.tab === "clips"
            ? copy.clipsEmptyOpen
            : copy.songsEmptyOpen
          : state.tab === "clips"
            ? copy.clipsEmptyClosed
            : copy.songsEmptyClosed;
      }
    }

    if (!queueList) return;
    queueList.replaceChildren();

    if (lane.queue.length === 0) {
      const empty = document.createElement("div");
      empty.className = "demo-queue-empty";
      empty.setAttribute("role", "status");
      empty.innerHTML = `<span class="demo-queue-empty-icon" aria-hidden="true"></span><p></p>`;
      empty.querySelector("p")!.textContent = open
        ? state.tab === "clips"
          ? copy.clipsEmptyOpen
          : copy.songsEmptyOpen
        : state.tab === "clips"
          ? copy.clipsEmptyClosed
          : copy.songsEmptyClosed;
      queueList.append(empty);
      return;
    }

    const ol = document.createElement("ol");
    ol.className = "demo-clips";
    lane.queue.forEach((clip, i) => {
      const li = document.createElement("li");
      li.className = "demo-clip";
      li.innerHTML = `<button type="button" class="demo-thumb-btn" aria-label=""><span class="demo-thumb"><span class="dur"></span></span></button><div class="demo-clip-body"><p class="demo-clip-title"></p><p class="demo-clip-meta"></p></div>`;
      const btn = li.querySelector<HTMLButtonElement>(".demo-thumb-btn")!;
      const thumb = li.querySelector<HTMLElement>(".demo-thumb")!;
      btn.setAttribute("aria-label", `Play ${clip.title}`);
      btn.addEventListener("click", () => playFromQueue(clip.id));
      thumb.className = `demo-thumb tone-${clip.tone}`;
      mountAsciiThumb(thumb, toneSeed(clip.tone) + i, paletteForTone(clip.tone));
      li.querySelector(".dur")!.textContent = clip.duration;
      li.querySelector(".demo-clip-title")!.textContent = `${i + 1}. ${clip.title}`;
      li.querySelector(".demo-clip-meta")!.textContent =
        state.tab === "songs" ? clip.user : `${clip.source} · ${clip.user}`;
      ol.append(li);
    });
    queueList.append(ol);
  }

  render();
  restartProgress();
}

function toneSeed(tone: Tone): number {
  return { a: 0, b: 1, c: 2, d: 3 }[tone];
}

function paletteForTone(tone: Tone): AsciiPalette {
  return (
    {
      a: ASCII_PALETTES.youtube,
      b: ASCII_PALETTES.ember,
      c: ASCII_PALETTES.slate,
      d: ASCII_PALETTES.wine,
    } as const
  )[tone];
}

start();
