import { useEffect, useRef, useState } from "react";
import { ACCESS_GROUPS, PROVIDERS, type AccessGroup, type Ban, type Provider, type QueueState } from "../shared/types";
import { api } from "./api";
import { PROVIDER_LABEL } from "./clip-meta";
import { CloseIcon, ProviderIcon } from "./icons";

const GROUP_LABEL: Record<AccessGroup, string> = {
  everyone: "Everyone",
  subscriber: "Subs",
  og: "OG",
  vip: "VIP",
  moderator: "Mods",
};

export const BAN_CHOICES: { label: string; minutes: number | null }[] = [
  { label: "10 min", minutes: 10 },
  { label: "1 hour", minutes: 60 },
  { label: "1 day", minutes: 60 * 24 },
  { label: "1 week", minutes: 60 * 24 * 7 },
  { label: "Permanent", minutes: null },
];

type Run = (p: Promise<unknown>) => void;

/** Platforms (on/off, who can post) and banned viewers. Every change saves right away. */
export function SettingsDialog({ state, open, onClose, run }: { state: QueueState; open: boolean; onClose: () => void; run: Run }) {
  const ref = useModal(open, onClose);
  const { settings, bans } = state;

  const setEnabled = (p: Provider, on: boolean) => {
    const providers = on ? PROVIDERS.filter((x) => x === p || settings.providers.includes(x)) : settings.providers.filter((x) => x !== p);
    run(api.settings({ providers }));
  };

  const toggleGroup = (p: Provider, g: AccessGroup) => {
    const current = settings.access[p] ?? ["everyone"];
    let next: AccessGroup[];
    if (g === "everyone") next = ["everyone"];
    else {
      const without = current.filter((x) => x !== "everyone");
      next = without.includes(g) ? without.filter((x) => x !== g) : [...without, g];
      if (!next.length) next = ["everyone"];
    }
    const access = { ...settings.access };
    if (next.includes("everyone")) delete access[p];
    else access[p] = next;
    run(api.settings({ access }));
  };

  return (
    <dialog ref={ref} className="dialog dialog-wide" aria-labelledby="settings-title" onClick={closeOnBackdrop}>
      <div className="dialog-head">
        <h2 id="settings-title">Settings</h2>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Close settings" onClick={onClose}>
          <CloseIcon size={18} stroke={2} />
        </button>
      </div>

      <section className="settings-section" aria-labelledby="platforms-title">
        <h3 id="platforms-title">Platforms</h3>
        <p className="settings-hint">
          Turn platforms on or off and choose who can post their links. Pick one or more groups (for example OG and Mods):
          anyone with any of those badges can post. You can always post.
        </p>
        <ul className="platforms">
          {PROVIDERS.map((p) => {
            const on = settings.providers.includes(p);
            const groups = settings.access[p] ?? ["everyone"];
            return (
              <li key={p} className={`platform${on ? "" : " off"}`}>
                <label className="switch platform-name">
                  <input type="checkbox" role="switch" checked={on} onChange={(e) => setEnabled(p, e.target.checked)} />
                  <span className="switch-ui" />
                  <ProviderIcon provider={p} size={18} stroke={1.75} />
                  {PROVIDER_LABEL[p]}
                </label>
                <div className="chips" role="group" aria-label={`Who can post ${PROVIDER_LABEL[p]} links`}>
                  {ACCESS_GROUPS.map((g) => (
                    <button
                      key={g}
                      type="button"
                      className="chip"
                      aria-pressed={groups.includes(g)}
                      disabled={!on}
                      onClick={() => toggleGroup(p, g)}
                    >
                      {GROUP_LABEL[g]}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="settings-section" aria-labelledby="bans-title">
        <h3 id="bans-title">Banned viewers</h3>
        <p className="settings-hint">
          Their links are ignored in clipQ (they can still chat on Kick). Mods can also type <code>!cq ban name</code>,{" "}
          <code>!cq timeout name 10m</code> or <code>!cq unban name</code>.
        </p>
        <BanForm run={run} />
        {bans.length === 0 ? (
          <p className="settings-empty">Nobody is banned.</p>
        ) : (
          <ul className="bans">
            {bans.map((b) => (
              <li key={b.id}>
                <span className="ban-name">{b.username}</span>
                <span className="ban-until">{banUntil(b)}</span>
                <button type="button" className="btn btn-ghost" onClick={() => run(api.unban(b.username))}>
                  Unban
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </dialog>
  );
}

function BanForm({ run }: { run: Run }) {
  const [name, setName] = useState("");
  const [choice, setChoice] = useState(0);
  return (
    <form
      className="ban-form"
      onSubmit={(e) => {
        e.preventDefault();
        const username = name.trim().replace(/^@/, "");
        if (!username) return;
        run(api.ban(username, BAN_CHOICES[choice]!.minutes));
        setName("");
      }}
    >
      <div className="field">
        <label htmlFor="ban-name">Username</label>
        <input id="ban-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="username" autoComplete="off" spellCheck={false} />
      </div>
      <div className="field">
        <label htmlFor="ban-length">For</label>
        <select id="ban-length" value={choice} onChange={(e) => setChoice(Number(e.target.value))}>
          {BAN_CHOICES.map((c, i) => (
            <option key={c.label} value={i}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      <button className="btn btn-danger" disabled={!name.trim()}>
        Ban
      </button>
    </form>
  );
}

/** Quick ban for the viewer who requested a clip. */
export function BanDialog({ username, onClose, run }: { username: string | null; onClose: () => void; run: Run }) {
  const ref = useModal(username !== null, onClose);
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="ban-title" onClick={closeOnBackdrop}>
      <h2 id="ban-title">Ban {username}?</h2>
      <p>Their waiting clips are removed and their links are ignored until the ban ends.</p>
      <div className="ban-choices">
        {BAN_CHOICES.map((c) => (
          <button
            key={c.label}
            type="button"
            className={`btn${c.minutes === null ? " btn-danger" : ""}`}
            onClick={() => {
              if (username) run(api.ban(username, c.minutes));
              onClose();
            }}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="dialog-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </dialog>
  );
}

function banUntil(b: Ban) {
  if (b.until === null) return "Permanent";
  const left = b.until - Date.now();
  if (left < 60_000) return "Less than a minute left";
  if (left < 3_600_000) return `${Math.round(left / 60_000)} min left`;
  if (left < 86_400_000) return `${Math.round(left / 3_600_000)} h left`;
  return `Until ${new Date(b.until).toLocaleDateString()}`;
}

/** Keeps a native <dialog> in sync with `open`; Esc and the close event call onClose. */
function useModal(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onDialogClose = () => close.current();
    d.addEventListener("close", onDialogClose);
    return () => d.removeEventListener("close", onDialogClose);
  }, []);
  return ref;
}

function closeOnBackdrop(e: React.MouseEvent<HTMLDialogElement>) {
  if (e.target === e.currentTarget) e.currentTarget.close();
}
