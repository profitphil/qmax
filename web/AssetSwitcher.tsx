import { useEffect, useMemo, useRef, useState } from "react";
import { livePrice, shownName } from "./client.ts";
import type { AssetItem } from "./client.ts";
import { useAssetCatalog } from "./catalog.ts";
import { busiestIn, useVolWindow, volumeOf } from "./volwin.tsx";
import { useFavorites } from "./favorites.ts";
import { compactPrice } from "./AssetList.tsx";
import { Icon } from "./ui.tsx";

const SHOWN = 60;
const typing = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]");

/** Qubic itself, as an entry beside the assets: its chart is the home of the trading screen. */
export const QU_ENTRY: AssetItem = { id: "QU", symbol: "QU", issuer: "", category: "token", venues: [], priceQu: 1, liquidityQu: 0 };
const isQu = (a: AssetItem) => a.id === QU_ENTRY.id && !a.issuer;
/** What the lists call an entry: Qubic's own is "Qubic". */
const nameOf = (a: AssetItem) => (isQu(a) ? "Qubic" : shownName(a));

interface Props {
  current: AssetItem;
  /** Opens another asset. */
  onPick: (asset: AssetItem) => void;
  /** Goes to Qubic's own chart. Given where Qubic is not the current entry, it is offered in the picker and the arrows (as the first entry, before the busiest asset). */
  onQubic?: () => void;
  /** Whether "/" opens the picker. Off where the page already gives "/" to its own search. */
  slash?: boolean;
}

/**
 * The symbol at the top of the trade screen, as a way to move to another asset without going back to the list: arrows to the
 * next and previous asset by volume ([ and ] on the keyboard), and the symbol itself opens a search over every asset. Typing
 * narrows it, up and down and Enter choose, Esc shuts only the picker.
 */
export function AssetSwitcher({ current, onPick, onQubic, slash }: Props) {
  const [win] = useVolWindow();
  // The catalog arrives busiest first over 24 hours; the picker follows the window chosen for the list.
  const catalog = useAssetCatalog();
  const sorted = useMemo(() => [...catalog].sort(busiestIn(win)), [catalog, win]);
  // Qubic leads the cycle (the home of the screen), so the arrows run Qubic, the busiest asset, the next one, and round again.
  const assets = useMemo(() => (onQubic || isQu(current) ? [QU_ENTRY, ...sorted] : sorted), [sorted, onQubic, current.id]);
  const favs = useFavorites();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);

  /** Opens an entry: Qubic's chart for Qubic, the asset's screen for the rest. */
  const choose = (a: AssetItem) => (isQu(a) ? onQubic?.() : onPick(a));
  const at = assets.findIndex((a) => a.id === current.id);
  const step = (by: 1 | -1) => {
    if (assets.length === 0) return;
    const next = at < 0 ? (by === 1 ? 0 : assets.length - 1) : (at + by + assets.length) % assets.length;
    choose(assets[next]);
  };

  // What the picker offers: your favorites first when nothing is typed, then everything busiest first.
  const options = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (q) return assets.filter((a) => nameOf(a).toUpperCase().includes(q) || a.symbol.toUpperCase().includes(q)).sort((a, b) => Number(nameOf(b).toUpperCase().startsWith(q)) - Number(nameOf(a).toUpperCase().startsWith(q)) || busiestIn(win)(a, b)).slice(0, SHOWN);
    const starred = assets.filter((a) => favs.has(a.id));
    // Qubic first, then your favorites, then everything busiest first
    return [...assets.filter(isQu), ...starred, ...assets.filter((a) => !favs.has(a.id) && !isQu(a))].slice(0, SHOWN);
  }, [assets, query, favs.ids, win]);

  useEffect(() => setActive(0), [query, open]);
  useEffect(() => {
    // Keeps the highlighted row in view by moving the list only: scrollIntoView would also move every scrolling parent, the page included (on a phone that slid the page sideways).
    const ul = list.current;
    const li = ul?.children[active] as HTMLElement | undefined;
    if (!ul || !li) return;
    const l = li.getBoundingClientRect();
    const u = ul.getBoundingClientRect();
    if (l.top < u.top) ul.scrollTop -= u.top - l.top;
    else if (l.bottom > u.bottom) ul.scrollTop += l.bottom - u.bottom;
  }, [active]);

  // Close on a click anywhere else.
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [open]);

  // [ and ] go to the previous and next asset, "/" opens the picker, unless the keys are going into a box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (e.key === "[" || e.key === "]") {
        e.preventDefault();
        step(e.key === "]" ? 1 : -1);
      } else if (slash && e.key === "/") {
        e.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const pick = (a: AssetItem) => {
    setOpen(false);
    setQuery("");
    if (a.id !== current.id) choose(a);
  };

  return (
    <div className="switch" ref={root}>
      <button type="button" className="iconbtn sm switch-step" onClick={() => step(-1)} disabled={assets.length === 0} aria-label="Previous asset" title="Previous asset in the list ( [ )">
        <Icon name="chevron" size={14} className="switch-left" />
      </button>
      <button type="button" className="switch-name" onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open} title="Switch to another asset">
        <h2>{nameOf(current)}</h2>
        <Icon name="chevron" size={14} />
      </button>
      <button type="button" className="iconbtn sm switch-step" onClick={() => step(1)} disabled={assets.length === 0} aria-label="Next asset" title="Next asset in the list ( ] )">
        <Icon name="chevron" size={14} className="switch-right" />
      </button>

      {open && (
        <div className="switch-pop" role="dialog" aria-label="Switch asset">
          <input
            autoFocus
            className="switch-search"
            placeholder="Switch to… (type a symbol)"
            aria-label="Search assets"
            role="combobox"
            aria-expanded="true"
            aria-controls="switch-list"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation(); // shuts the picker, not the dialog behind it
                setOpen(false);
              } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(0, Math.min(options.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
              } else if (e.key === "Enter" && options[active]) {
                e.preventDefault();
                pick(options[active]);
              }
            }}
          />
          <ul id="switch-list" ref={list} className="switch-list" role="listbox">
            {options.map((a, i) => (
              <li key={`${a.id}|${a.issuer}`} role="option" aria-selected={a.id === current.id} className={`${i === active ? "active" : ""}${a.id === current.id ? " current" : ""}`} onMouseMove={() => setActive(i)} onClick={() => pick(a)}>
                {favs.has(a.id) && !query ? <Icon name="star" size={12} fill /> : <span className="switch-gap" />}
                <b>{nameOf(a)}</b>
                <span className="switch-kind">{isQu(a) ? "the coin" : a.category === "contract" ? "contract" : "token"}</span>
                <span className="num switch-price">{isQu(a) ? "" : compactPrice(livePrice(a))}</span>
                <span className="num switch-vol">{isQu(a) ? "" : volumeOf(a, win) ? compactPrice(volumeOf(a, win)) : "–"}</span>
              </li>
            ))}
            {options.length === 0 && <li className="switch-none">{assets.length === 0 ? "Loading assets…" : `Nothing matches “${query.trim()}”.`}</li>}
          </ul>
          <p className="switch-foot">Price in QU · {win} volume · ↑↓ to move, Enter to open</p>
        </div>
      )}
    </div>
  );
}
