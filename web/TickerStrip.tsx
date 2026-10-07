import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { compactPrice, formatPrice } from "./AssetList.tsx";
import { SideMark, useTapeFeed } from "./TradeTape.tsx";
import { quietWords } from "../src/tapewords.ts";
import { agoLabel, compactQu } from "./tape-api.ts";
import type { TapeRow } from "./tape-api.ts";
import { AssetName, Icon } from "./ui.tsx";
import { useMedia } from "./media.ts";

const COUNT = 15;
/** How fast the belt moves, in pixels a second: slow enough to read a trade as it passes. */
const SPEED = 32;
/** The space between two trades on the belt (the same as `gap` in tape.css). */
const GAP = 2;
const PAUSE_KEY = "qmax.ticker.paused";
const n = (x: number) => x.toLocaleString("en-US");

const readPaused = () => {
  try {
    return localStorage.getItem(PAUSE_KEY) === "1";
  } catch {
    return false; // storage can be blocked: the strip just moves
  }
};

interface ItemProps {
  row: TapeRow;
  now: number;
  /** Tinted for a while: it arrived while the page was open. */
  isNew: boolean;
  onSelectAsset: (asset: string) => void;
}

function Item({ row: r, now, isNew, onSelectAsset }: ItemProps) {
  return (
    <li>
      <button
        type="button"
        className={isNew ? "ticker-item new" : "ticker-item"}
        onClick={() => onSelectAsset(r.asset)}
        title={`${agoLabel(now - r.t)} on ${r.venue}: ${n(r.qty)} ${r.asset} for ${n(r.qu)} QU`}
        aria-label={`${r.asset}, ${r.side ?? "direction unknown"}, ${n(r.qty)} units at ${formatPrice(r.price)} QU each, ${n(r.qu)} QU in total, ${agoLabel(now - r.t)} on ${r.venue}. Open ${r.asset}.`}
      >
        <b><AssetName id={r.asset} /></b>
        <span className={`ticker-side ${r.side ?? "unknown"}`}>
          <SideMark side={r.side} />
        </span>
        <span className="num">{compactPrice(r.price)} QU</span>
        <span className="ticker-size num">{compactQu(r.qu)} QU</span>
      </button>
    </li>
  );
}

interface Slot {
  key: number;
  row: TapeRow;
  isNew: boolean;
}

/**
 * The trades on a belt that slides slowly from right to left. A trade that arrives while the page is open is put on at the right
 * edge (so it is seen coming in); when nothing new has arrived the belt goes round the latest trades again. A trade is taken off once
 * it has gone out of sight on the left, and the belt's position is corrected by its width in the same frame, so nothing jumps.
 * The pointer or the keyboard being on the strip stops it (a trade is hard to click while it moves), and so does the pause button.
 */
function Belt({ rows, now, paused, onSelectAsset }: { rows: TapeRow[]; now: number; paused: boolean; onSelectAsset: (asset: string) => void }) {
  const [slots, setSlots] = useState<Slot[]>([]);
  const viewport = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLUListElement>(null);
  const offset = useRef(0); // how far the belt has moved left, in px
  const touched = useRef(false); // the pointer or keyboard is on the strip
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const removing = useRef<number | null>(null); // width of the trade being taken off, until the change is on screen
  const adding = useRef(false);
  const seq = useRef(0);
  const seen = useRef(new Set<number>());
  const arrivals = useRef<TapeRow[]>([]); // new trades waiting for their turn on the belt, oldest first
  const cycle = useRef<TapeRow[]>([]); // what the belt goes round with when nothing is new (newest first)
  const cycleAt = useRef(0);

  // Tell new trades from the ones already known.
  useEffect(() => {
    cycle.current = rows;
    const known = seen.current;
    const added = rows.filter((r) => !known.has(r.id));
    const first = known.size === 0;
    if (known.size > 400) known.clear();
    for (const r of rows) known.add(r.id);
    // The first read, or a server that started its ids over (everything looks new), is not an arrival.
    if (!first && added.length > 0 && added.length <= 5) arrivals.current.push(...added.reverse());
    arrivals.current = arrivals.current.slice(-5);
  }, [rows]);

  const nextSlot = (): Slot | null => {
    const arrived = arrivals.current.shift();
    if (arrived) return { key: ++seq.current, row: arrived, isNew: true };
    const list = cycle.current;
    if (list.length === 0) return null;
    return { key: ++seq.current, row: list[cycleAt.current++ % list.length], isNew: false };
  };

  // The belt has changed on screen: it may move on, and the part taken off the left is made up for in the position.
  useLayoutEffect(() => {
    adding.current = false;
    if (removing.current !== null) {
      offset.current = Math.max(0, offset.current - removing.current);
      removing.current = null;
      if (track.current) track.current.style.transform = `translate3d(${-offset.current}px,0,0)`;
    }
  }, [slots]);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(t - last, 100) / 1000; // a tab that was away does not leap
      last = t;
      const view = viewport.current;
      const belt = track.current;
      if (!view || !belt) return;
      if (!pausedRef.current && !touched.current && document.visibilityState === "visible") {
        offset.current += SPEED * dt;
        belt.style.transform = `translate3d(${-offset.current}px,0,0)`;
      }
      const first = belt.firstElementChild as HTMLElement | null;
      if (first && removing.current === null && first.offsetLeft + first.offsetWidth + GAP < offset.current) {
        removing.current = first.offsetWidth + GAP;
        setSlots((s) => s.slice(1));
      }
      if (!adding.current) {
        const tail = belt.lastElementChild as HTMLElement | null;
        const end = tail ? tail.offsetLeft + tail.offsetWidth - offset.current : 0;
        if (end < view.clientWidth + 80) {
          const slot = nextSlot();
          if (slot) {
            adding.current = true;
            setSlots((s) => [...s, slot]);
          }
        }
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      ref={viewport}
      className="ticker-belt"
      onPointerEnter={() => (touched.current = true)}
      onPointerLeave={() => (touched.current = false)}
      onFocus={() => (touched.current = true)}
      onBlur={() => (touched.current = false)}
    >
      <ul ref={track} className="ticker-track">
        {slots.map((s) => (
          <Item key={s.key} row={s.row} now={now} isNew={s.isNew} onSelectAsset={onSelectAsset} />
        ))}
      </ul>
    </div>
  );
}

/**
 * A slim strip of the latest trades across every asset: symbol, which way it went, price and size in QU. It slides slowly across
 * (`Belt`) and stops under the pointer or when the pause button is pressed. For anyone who asked their system for less motion it
 * is a plain row that scrolls sideways by hand instead. Clicking a trade calls `onSelectAsset` with the asset's id (its symbol,
 * unless two issuers share one) to open it.
 */
export function TickerStrip({ onSelectAsset }: { onSelectAsset: (asset: string) => void }) {
  const { rows, flow, loaded, error, fresh, now } = useTapeFeed({ limit: COUNT });
  const still = useMedia("(prefers-reduced-motion: reduce)");
  const [paused, setPaused] = useState(readPaused);
  const toggle = () =>
    setPaused((p) => {
      try {
        localStorage.setItem(PAUSE_KEY, p ? "0" : "1");
      } catch {
        // not remembered: the choice still holds until the page is reloaded
      }
      return !p;
    });
  const shown = rows.slice(0, COUNT);
  return (
    <section className="ticker" aria-label="Latest trades on QX and QSwap">
      <span className="ticker-label">
        {loaded && !error && <i className="pulse" />} Latest
      </span>
      {!loaded && !error && (
        <div className="ticker-list" role="status" aria-label="Loading trades">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="skeleton ticker-skeleton" />
          ))}
        </div>
      )}
      {error && rows.length === 0 && <span className="note ticker-note">Live trades are not available right now.</span>}
      {loaded && rows.length === 0 && <span className="note ticker-note">{quietWords({ partial: !!flow?.partial, coveredFromMs: flow?.coveredFromMs ?? null, now }).headline}</span>}
      {shown.length > 0 && still && (
        <ul className="ticker-list">
          {shown.map((r) => (
            <Item key={r.id} row={r} now={now} isNew={fresh.has(r.id)} onSelectAsset={onSelectAsset} />
          ))}
        </ul>
      )}
      {shown.length > 0 && !still && <Belt rows={shown} now={now} paused={paused} onSelectAsset={onSelectAsset} />}
      {shown.length > 0 && !still && (
        <button type="button" className="iconbtn sm ticker-pause" onClick={toggle} aria-pressed={paused} aria-label={paused ? "Resume the scrolling trades" : "Pause the scrolling trades"} title={paused ? "Resume" : "Pause"}>
          <Icon name={paused ? "play" : "pause"} size={13} />
        </button>
      )}
    </section>
  );
}
