import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon, Logo, QubicHeart, QubicMark } from "./ui.tsx";
import { useTheme } from "./theme.ts";
import { loadTally } from "./savings.tsx";
import { tallyLine } from "../src/savings.ts";
import { useMembership } from "./membership-api.ts";
import type { MembershipResponse } from "./membership-api.ts";
import { usdPerQu } from "./qu-api.ts";
import type { QuSnapshot } from "./qu-api.ts";
import { proTitle, useMaxMode } from "./maxmode.tsx";
import { useTipJarUrl } from "./support.ts";

const EXPLORER = "https://explorer.qubic.org";
const short = (a: string) => `${a.slice(0, 5)}…${a.slice(-5)}`;
const compact = (n: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n);

/** A flat colour derived from the address, so a wallet is recognisable at a glance. */
function identicon(address: string) {
  let h = 7;
  for (const ch of address) h = (h * 33 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 45% 48%)`;
}

export interface MarketStats {
  assets: number;
  both: number;
  arb: number;
  ready: boolean;
}

export interface NavPage {
  id: string;
  label: string;
}

interface NavProps {
  /** Workspaces to switch between (Trade, Orders…), shown as tabs in the title bar. */
  pages?: NavPage[];
  page?: string;
  onPage?: (id: string) => void;
  /** The price of QU in dollars, shown at the centre of the bar; clicking it opens its chart. */
  qu?: QuSnapshot | null;
  onQubic?: () => void;
  connected: boolean;
  address?: string;
  alias?: string;
  balanceQu: number | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onSettings: () => void;
  /** Opens the support window (QMax is free: this is how to give something back). */
  onSupport?: () => void;
}

export function Nav({ pages, page, onPage, qu, onQubic, connected, address, alias, balanceQu, onConnect, onDisconnect, onSettings, onSupport }: NavProps) {
  const { theme, toggle } = useTheme();
  const tipUrl = useTipJarUrl();
  return (
    <header className="nav">
      <div className="nav-in">
        <div className="nav-left">
        <a className="nav-logo" href="/" aria-label="QMax home">
          <Logo />
        </a>
        {pages && onPage && (
          <nav className="nav-pages" aria-label="Workspaces">
            {pages.map((p) => (
              <button key={p.id} className={p.id === page ? "navtab on" : "navtab"} aria-current={p.id === page ? "page" : undefined} onClick={() => onPage(p.id)}>
                {p.label}
              </button>
            ))}
          </nav>
        )}
        </div>
        <button type="button" className="qu-chip" onClick={onQubic} title="The price of Qubic (QU) in dollars: open its chart" aria-label={qu ? `Qubic price ${usdPerQu(qu.usdPerQu)}${qu.change24hPct !== null ? `, ${qu.change24hPct >= 0 ? "up" : "down"} ${Math.abs(qu.change24hPct).toFixed(1)} percent in 24 hours` : ""}. Open the chart.` : "Qubic price. Open the chart."}>
          <QubicMark size={18} />
          <span className="num qu-chip-price">{qu ? usdPerQu(qu.usdPerQu) : "–"}</span>
          {qu?.change24hPct != null && <span className={`num qu-chip-change ${qu.change24hPct > 0.05 ? "up" : qu.change24hPct < -0.05 ? "down" : ""}`}>{qu.change24hPct > 0.05 ? "▲" : qu.change24hPct < -0.05 ? "▼" : ""}{Math.abs(qu.change24hPct).toFixed(1)}%</span>}
        </button>
        <div className="nav-actions">
          {tipUrl ? (
            <a className="navlink nav-heart" href={tipUrl} target="_blank" rel="noreferrer" title="Tip QMax with Q+Pay. QMax is free for everyone." aria-label="Tip QMax with Q+Pay">
              <QubicHeart />
            </a>
          ) : (
            onSupport && (
              <button type="button" className="navlink nav-heart" onClick={onSupport} title="QMax is free for everyone. Support it with some QU." aria-label="Support QMax">
                <QubicHeart />
              </button>
            )
          )}
          <a className="navlink" href={EXPLORER} target="_blank" rel="noreferrer">
            Explorer <Icon name="arrowUpRight" size={14} />
          </a>
          <button className="iconbtn" onClick={toggle} aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} title={theme === "dark" ? "Light theme" : "Dark theme"}>
            <Icon name={theme === "dark" ? "sun" : "moon"} />
          </button>
          <button className="iconbtn" onClick={onSettings} aria-label="Settings" title="Settings">
            <Icon name="sliders" />
          </button>
          {connected && address ? (
            <WalletMenu address={address} alias={alias} balanceQu={balanceQu} onDisconnect={onDisconnect} />
          ) : (
            <button className="primary" onClick={onConnect}>
              <Icon name="wallet" size={15} /> <span>Connect<span className="hide-sm"> wallet</span></span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

function WalletMenu({ address, alias, balanceQu, onDisconnect }: { address: string; alias?: string; balanceQu: number | null; onDisconnect: () => void }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const { membership, refresh } = useMembership(address);
  // Read again each time the menu is opened, so a payment made a minute ago on Discord shows.
  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // the full address is shown in the menu: it can be selected by hand
    }
  };

  return (
    <div className="walletmenu" ref={root}>
      <button className="walletpill" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} title={address}>
        <span className="identicon" style={{ background: identicon(address) }} />
        <span className="walletpill-text">
          <b>{alias || short(address)}</b>
          {balanceQu !== null && <small>{compact(balanceQu)} QU</small>}
        </span>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <span className="identicon lg" style={{ background: identicon(address) }} />
            <div>
              {alias && <b>{alias}</b>}
              <code className="addr">{address}</code>
              {balanceQu !== null && <span className="menu-bal">{balanceQu.toLocaleString("en-US")} QU</span>}
            </div>
          </div>
          <MemberBlock m={membership} />
          {tallyLine(loadTally(address)) && (
            <p className="menu-saved"><Icon name="bolt" size={13} fill /> {tallyLine(loadTally(address))}</p>
          )}
          <button className="menu-item" role="menuitem" onClick={copy}>
            <Icon name={copied ? "check" : "copy"} size={16} /> {copied ? "Copied" : "Copy address"}
          </button>
          <a className="menu-item" role="menuitem" href={`${EXPLORER}/network/address/${address}`} target="_blank" rel="noreferrer">
            <Icon name="external" size={16} /> View on explorer
          </a>
          <button
            className="menu-item danger"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onDisconnect();
            }}
          >
            <Icon name="logout" size={16} /> Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

const qu = (n: number) => `${Math.round(n).toLocaleString("en-US")} QU`;
const day = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** Whether this wallet is a member (found by the wallet, so a Discord subscription shows here too) and what it has earned in profit share. */
export function MemberBlock({ m }: { m: MembershipResponse | null }) {
  if (!m) return null;
  const share = m.profitShare;
  const earned = !!share && (share.earnedQu > 0 || share.paidQu > 0 || share.thisMonth.estimatedQu > 0);
  if (!m.active && !earned) return null;
  const how = m.source === "subscription" ? (m.subscription.discordIds.length ? "Subscriber (paid through Discord)" : "Subscriber") : m.source === "pass" ? "Pass holder" : "Not a member right now";
  return (
    <div className="menu-member" aria-label="Membership">
      <p className="menu-member-head">
        <Icon name={m.active ? "check" : "clock"} size={14} /> <b>{how}</b>
        {m.active && m.until && <span> until {day(m.until)}</span>}
      </p>
      {share && earned && (
        <dl className="menu-member-share" title={share.note}>
          <dt>Profit share this month (estimate)</dt>
          <dd>{qu(share.thisMonth.estimatedQu)}</dd>
          <dt>Earned in finished months</dt>
          <dd>{qu(share.earnedQu)}</dd>
          <dt>Paid to you</dt>
          <dd>{qu(share.paidQu)}</dd>
          {share.owedQu > 0 && (
            <>
              <dt>Waiting to be paid</dt>
              <dd className="owed">{qu(share.owedQu)}</dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}

function Stat({ label, value, title, tone, locked }: { label: string; value: string | null; title: string; tone?: "accent" | "warn"; locked?: () => void }) {
  if (locked)
    return (
      <div className="mstat locked">
        <button type="button" className="mstat-lock" onClick={locked} title={title}>
          <dt>{label}</dt>
          <dd>&ndash;</dd>
        </button>
      </div>
    );
  return (
    <div className={`mstat${tone ? ` ${tone}` : ""}`} title={title}>
      <dt>{label}</dt>
      <dd>{value === null ? <span className="skeleton stat-skel" /> : value}</dd>
    </div>
  );
}

/** One line under the title bar: how many assets there are and how many are worth a look, then the latest trades (the `children`). */
export function MarketBar({ stats, children }: { stats: MarketStats | null; children?: ReactNode }) {
  const num = (n: number) => n.toLocaleString("en-US");
  const known = !!stats && (stats.ready || stats.assets > 0);
  const max = useMaxMode();
  return (
    <section className="marketbar" aria-label="Market overview">
      <dl className="mstats">
        <Stat label="Assets" value={known ? num(stats!.assets) : null} title={stats && !stats.ready ? "Still scanning the network for tradable assets" : "Assets tradable on QX and QSwap"} />
        <Stat label="On both markets" value={known ? num(stats!.both) : null} tone="accent" title="Assets that trade on both QX and QSwap, so an order can be split for the best price" />
        <Stat
          label="Arbitrage"
          value={known ? num(stats!.arb) : null}
          tone={stats && stats.arb > 0 ? "warn" : undefined}
          title={max.active ? "Assets where buying on one market and selling on the other leaves a profit after every fee, by your settings" : `Which assets have an arbitrage open between QX and QSwap is part of Max. Click to switch Max on${proTitle(max.access)}`}
          locked={max.active ? undefined : () => max.setOn(true)}
        />
      </dl>
      {children}
    </section>
  );
}

export function StatusBar({ onSupport }: { onSupport?: () => void }) {
  return (
    <footer className="statusbar">
      <span className="sb-net" title="Reading live data from the Qubic network">
        <i className="pulse" /> Mainnet
      </span>
      <span className="sb-text">
        Non-custodial: QMax never holds your funds or keys, and you sign every transaction in your own wallet. Quotes are estimates; prices can move before your transactions confirm.
      </span>
      {onSupport && (
        <button type="button" className="sb-link sb-support" onClick={onSupport}>
          <Icon name="heart" size={11} /> Support QMax
        </button>
      )}
      <a className="sb-link" href={EXPLORER} target="_blank" rel="noreferrer">Qubic Explorer</a>
    </footer>
  );
}
