import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLogo } from "./logos.ts";
import { noteLogo, roundOf } from "./logofill.ts";

/* ---------- Icons: one stroke style, 24px grid ---------- */

const ICONS = {
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  heart: <path d="M12 20.2S4 15.1 4 9.6A4.1 4.1 0 0 1 8.2 5.5c1.6 0 3 .9 3.8 2.2.8-1.3 2.2-2.2 3.8-2.2A4.1 4.1 0 0 1 20 9.6c0 5.5-8 10.6-8 10.6Z" />,
  star: <path d="m12 3.6 2.6 5.4 5.9.8-4.3 4.1 1.1 5.9L12 17l-5.3 2.8 1.1-5.9L3.5 9.8l5.9-.8Z" />,
  sliders: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
  sun: <><circle cx="12" cy="12" r="3.8" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></>,
  moon: <path d="M20 14.2A8 8 0 0 1 9.8 4a8 8 0 1 0 10.2 10.2Z" />,
  wallet: <><path d="M4 8.5A2.5 2.5 0 0 1 6.5 6H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6.5A2.5 2.5 0 0 1 4 16.5Z" /><path d="M4 8.5C4 7.1 5.1 6 6.5 6H16" /><circle cx="16" cy="13" r="1.1" /></>,
  chevron: <path d="m6 9 6 6 6-6" />,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2.2" /><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15" /></>,
  external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v3.5a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 4 17.5v-9A2.5 2.5 0 0 1 6.5 6H10" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  pause: <path d="M8.5 5.5v13M15.5 5.5v13" />,
  pin: <path d="M9 4h6l-.8 5.6L17.5 13h-11l3.3-3.4ZM12 13v7" />,
  play: <path d="M8 5.5v13l10-6.5Z" />,
  alert: <><path d="M12 4.2 21 19.5H3Z" /><path d="M12 10v4M12 16.8v.01" /></>,
  arrowUpRight: <path d="M7 17 17 7M8.5 7H17v8.5" />,
  swap: <path d="M4 8h13M14 4.5 17.5 8 14 11.5M20 16H7M10 12.5 6.5 16 10 19.5" />,
  bolt: <path d="M13 3 5 13.5h5.5L10 21l8-10.5h-5.5Z" />,
  bot: <><rect x="5" y="8" width="14" height="10" rx="2.5" /><path d="M12 8V5M9.5 12.5v.01M14.5 12.5v.01M9 18v2M15 18v2" /></>,
  logout: <><path d="M10 5H6.5A2.5 2.5 0 0 0 4 7.5v9A2.5 2.5 0 0 0 6.5 19H10" /><path d="m15 8 4 4-4 4M19 12H9" /></>,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 7.9v.01" /></>,
  chart: <><path d="M4 4v15.5a.5.5 0 0 0 .5.5H20" /><path d="m8 15 3-4 3 2.2L18.5 7" /></>,
  book: <path d="M5 6h6M5 10h9M5 14h6M5 18h9M15 6h4M15 14h4" />,
  shield: <path d="M12 3.5 19 6v5.5c0 4.2-2.9 7.4-7 9-4.1-1.6-7-4.8-7-9V6Z" />,
  layers: <><path d="m12 4 8.5 4.5L12 13 3.5 8.5Z" /><path d="m3.5 12.5 8.5 4.5 8.5-4.5" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  wallet2: <><rect x="3.5" y="6" width="17" height="12" rx="3" /><path d="M3.5 10h17" /></>,
  inbox: <><path d="M4 13.5 6.4 6.2A1.5 1.5 0 0 1 7.8 5h8.4a1.5 1.5 0 0 1 1.4 1.2L20 13.5" /><path d="M4 13.5V17a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3.5h-4.5a1.5 1.5 0 0 0-1.5 1.5 1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 9 15a1.5 1.5 0 0 0-1.5-1.5Z" /></>,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18, fill = false, className }: { name: IconName; size?: number; fill?: boolean; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  );
}

/* ---------- Brand ---------- */

/**
 * The QMax mark for small spaces: the X of the logo, two arrows crossing (one up in green, one down in red). It is drawn as vector shapes so it stays sharp from a
 * favicon to a poster (the same shapes are in web/public/brand/qmax-x.svg, made by scripts/make-brand.mjs).
 */
export function LogoMark({ size = 22, outline = false }: { size?: number; outline?: boolean }) {
  // `outline` draws a white edge around the arrows, for the X on a colored button, where its own colors would not stand out.
  const edge = outline ? ({ stroke: "#fff", strokeWidth: 38, strokeLinejoin: "round", paintOrder: "stroke" } as const) : {};
  return (
    <svg className="logomark" width={(size * 292) / 301} height={size} viewBox={outline ? "-20 -20 332 341" : "0 0 292 301"} aria-hidden="true">
      <defs>
        <linearGradient id="qx-up" gradientUnits="userSpaceOnUse" x1="28" y1="271" x2="268" y2="34">
          <stop offset="0" stopColor="#0A8AC6" />
          <stop offset=".5" stopColor="#33AEA8" />
          <stop offset="1" stopColor="#24C294" />
        </linearGradient>
        <linearGradient id="qx-down" gradientUnits="userSpaceOnUse" x1="30" y1="46" x2="251" y2="260">
          <stop offset="0" stopColor="#1CBBD8" />
          <stop offset=".4" stopColor="#28B8B3" />
          <stop offset=".5" stopColor="#33AFA7" />
          <stop offset=".6" stopColor="#656A69" />
          <stop offset=".7" stopColor="#984F52" />
          <stop offset=".8" stopColor="#B33941" />
          <stop offset=".9" stopColor="#C82B36" />
          <stop offset="1" stopColor="#D22230" />
        </linearGradient>
      </defs>
      <path d="M0.5 31H57.5L251 234L269 216L286 301L203 285L223 261Z" fill="url(#qx-down)" {...edge} />
      <path d="M0.5 270H57.5L254 68L276 88L292 0L204 15L225 38Z" fill="url(#qx-up)" {...edge} />
    </svg>
  );
}

/**
 * The QMax logo: the letters "QMa" in the page's text colour (a mask, so they follow the theme) and the X mark in place of the "x". In a small space (a phone's title
 * bar) only the X is shown.
 */
export function Logo() {
  return (
    <span className="logo" aria-label="QMax">
      <span className="logo-word" aria-hidden="true" />
      <LogoMark />
    </span>
  );
}

/* ---------- Small pieces ---------- */

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} role="status" aria-label="Working" />;
}

/** The Qubic logo: the picture qubictrade.com shows for QU, kept at /brand/qubic.png. It stands for Qubic itself (QU), wherever QU is named. */
export const QUBIC_LOGO = "/brand/qubic.png";
export function QubicMark({ size = 18, className }: { size?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <b className={`qubic-mark qubic-mark-text ${className ?? ""}`} style={{ fontSize: Math.round(size * 0.55) }}>QU</b>;
  return <img className={`qubic-mark ${className ?? ""}`} src={QUBIC_LOGO} alt="" width={size} height={size} draggable={false} aria-hidden="true" onError={() => setBroken(true)} />;
}

/**
 * The Qubic heart: the pixel-art heart Qubic uses as its emoji, red with a white shine on the left lobe and the two black bars of the Qubic mark in the middle. It is
 * drawn on a 13 by 11 grid of squares, so a height of 22 (or any multiple of 11) keeps its pixels sharp. It stands for supporting QMax.
 */
export function QubicHeart({ size = 22 }: { size?: number }) {
  return (
    <svg className="qubic-heart" width={(size * 13) / 11} height={size} viewBox="0 0 13 11" aria-hidden="true">
      <path fill="#e63321" shapeRendering="crispEdges" d="M1 0h4v1H1zM8 0h4v1H8zM0 1h6v1H0zM7 1h6v1H7zM0 2h13v3H0zM1 5h11v1H1zM2 6h9v1H2zM3 7h7v1H3zM4 8h5v1H4zM5 9h3v1H5zM6 10h1v1H6z" />
      <path fill="#fcfaf6" shapeRendering="crispEdges" d="M2 1h2v1H2zM1 2h2v1H1zM1 3h1v1H1z" />
      <path fill="#0b0b14" d="M5.35 3.15h.8v2.8h-.8zM6.82 3.15h.8v3.95h-.8z" />
    </svg>
  );
}

/** An asset's logo when QMax has one; otherwise a badge whose tint comes from the symbol itself, so every asset is recognisable at a glance. QU itself (no issuer) is the Qubic logo. */
export function Avatar({ symbol, category, size = 40, issuer }: { symbol: string; category?: "contract" | "token"; size?: number; issuer?: string }) {
  const logo = useLogo(symbol, issuer);
  const [broken, setBroken] = useState<string | null>(null);
  const [, setLooked] = useState(0);
  if (symbol === "QU" && !issuer) return <QubicMark size={size} className="avatar-qu" />;
  let h = 0;
  for (const ch of symbol) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const style = { "--h": h, width: size, height: size, fontSize: Math.round(size * 0.34) } as CSSProperties;
  // The asset's own logo when QMax has one (a picture that will not load falls back to the letters).
  if (logo && broken !== logo) {
    // A round logo on a plain square: the badge is filled with the colour of the logo's rim and the picture is cut round, so no white (or grey) corners show.
    // The picture stays hidden until it has been looked at, so it never shows without the fill.
    const round = roundOf(logo);
    const filled = round ? ({ ...style, "--logo-fill": round.fill, "--logo-r": round.radius } as CSSProperties) : style;
    return (
      <span className={`avatar has-logo${round ? " round-logo" : ""} ${category ?? ""}`} style={filled} aria-hidden="true" title={category === "contract" ? "Smart contract shares" : category === "token" ? "Token" : undefined}>
        <img
          src={logo}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          style={round === undefined ? { visibility: "hidden" } : undefined}
          onLoad={(e) => {
            noteLogo(logo, e.currentTarget);
            setLooked((n) => n + 1);
          }}
          onError={() => setBroken(logo)}
        />
      </span>
    );
  }
  return (
    <span className={`avatar ${category ?? ""}`} style={style} aria-hidden="true" title={category === "contract" ? "Smart contract shares" : category === "token" ? "Token" : undefined}>
      {symbol.slice(0, 2)}
    </span>
  );
}

/**
 * An asset's name as the lists show it. Two assets can share a name (QTREAT, the contract's shares, and QTREAT issued by the QDOGE address): QMax tells them apart by
 * adding the first letters of the issuer's address to the second one's id (QTREAT.QDOGE), which is shown here smaller, after the name.
 */
export function AssetName({ id }: { id: string }) {
  const dot = id.indexOf(".");
  if (dot <= 0) return <>{id}</>;
  const issuer = id.slice(dot + 1);
  return (
    <>
      {id.slice(0, dot)}
      <small className="asset-issuer" title={`${id.slice(0, dot)} issued by the address that starts ${issuer}. Another asset has the same name.`}>.{issuer}</small>
    </>
  );
}

export type StepStatus = "pending" | "signing" | "confirming" | "done" | "failed";

/** The round marker in front of a transaction step. */
export function StepMark({ status }: { status: string }) {
  const s = status as StepStatus;
  return (
    <span className={`stepmark ${s}`} aria-label={s}>
      {s === "done" ? <Icon name="check" size={14} /> : s === "failed" ? <Icon name="close" size={14} /> : s === "signing" || s === "confirming" ? <Spinner size={14} /> : <i />}
    </span>
  );
}

/* ---------- Modal ---------- */

const openModals: symbol[] = [];

interface ModalProps {
  /** Closes the dialog (overlay click, Esc, the X). Leave it out while something is in progress that must not be interrupted. */
  onClose?: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
  children: ReactNode;
  /** Buttons and notes pinned under the content. */
  footer?: ReactNode;
  /** Render the content without padding and a header, for dialogs that lay themselves out. */
  bare?: boolean;
}

/** An accessible dialog: Esc closes it, focus stays inside and returns afterwards, the page behind does not scroll. On phones it is a bottom sheet. */
export function Modal({ onClose, title, subtitle, size = "md", className, children, footer, bare }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const titleId = useId();

  useEffect(() => {
    const me = Symbol("modal");
    openModals.push(me);
    const before = document.activeElement as HTMLElement | null;
    const dialog = ref.current!;
    if (!dialog.contains(document.activeElement)) dialog.focus();
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    const prevOverflow = document.body.style.overflow;
    const prevPad = document.body.style.paddingRight;
    document.body.style.overflow = "hidden";
    if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;

    const onKey = (e: KeyboardEvent) => {
      if (openModals[openModals.length - 1] !== me) return; // only the top dialog reacts
      if (e.key === "Escape" && closeRef.current) {
        e.stopPropagation();
        closeRef.current();
      }
      if (e.key === "Tab") {
        const items = [...dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null);
        if (!items.length) return e.preventDefault();
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      openModals.splice(openModals.indexOf(me), 1);
      if (openModals.length === 0) {
        document.body.style.overflow = prevOverflow;
        document.body.style.paddingRight = prevPad;
      }
      before?.focus?.();
    };
  }, []);

  return createPortal(
    <div
      className="overlay"
      onMouseDown={(e) => {
        // a press that starts on the backdrop closes it; a text selection that ends there does not
        if (e.target === e.currentTarget) closeRef.current?.();
      }}
      onClick={(e) => e.stopPropagation()} // React bubbles through portals: a click here must not reach a dialog underneath
    >
      <div ref={ref} className={`modal ${size}${bare ? " bare" : ""}${className ? ` ${className}` : ""}`} role="dialog" aria-modal="true" aria-labelledby={title ? titleId : undefined} tabIndex={-1}>
        {!bare && (title || onClose) && (
          <div className="modal-head">
            <div>
              {title && <h2 id={titleId}>{title}</h2>}
              {subtitle && <p className="modal-sub">{subtitle}</p>}
            </div>
            {onClose && (
              <button className="iconbtn" onClick={onClose} aria-label="Close" title="Close">
                <Icon name="close" />
              </button>
            )}
          </div>
        )}
        {bare ? children : <div className="modal-body">{children}</div>}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
