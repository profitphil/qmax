import { createContext, useCallback, useContext, useState } from "react";
import type { ReactNode } from "react";
import { DEFAULT_SETTINGS, sanitizeSettings } from "../src/settings.ts";
import type { Settings } from "../src/settings.ts";
import { Icon, Modal } from "./ui.tsx";
import { CoverModal } from "./CoverModal.tsx";
import { proTitle, useMaxMode } from "./maxmode.tsx";

const KEY = "qmax.settings";
const short = (a: string) => `${a.slice(0, 5)}…${a.slice(-5)}`;
const day = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

const read = (): Settings => {
  try {
    return sanitizeSettings(JSON.parse(localStorage.getItem(KEY) ?? "{}"));
  } catch {
    return DEFAULT_SETTINGS; // storage can be blocked; settings then last for the session only
  }
};

interface Ctx {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  reset: () => void;
}

const SettingsCtx = createContext<Ctx | undefined>(undefined);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(read);
  const save = (s: Settings) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      // ignore
    }
  };
  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((cur) => {
      const next = sanitizeSettings({ ...cur, ...patch });
      save(next);
      return next;
    });
  }, []);
  const reset = useCallback(() => {
    save(DEFAULT_SETTINGS);
    setSettings(DEFAULT_SETTINGS);
  }, []);
  return <SettingsCtx.Provider value={{ settings, update, reset }}>{children}</SettingsCtx.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsCtx);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}

export function SettingsModal({ onClose, onSupport }: { onClose: () => void; onSupport?: () => void }) {
  const { settings: s, update, reset } = useSettings();
  const max = useMaxMode();
  const [covering, setCovering] = useState(false);
  return (
    <>
    <Modal
      size="lg"
      className="settings"
      title="Settings"
      subtitle="Saved in this browser only."
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={reset}>Reset to defaults</button>
          {onSupport && (
            <button className="ghost" onClick={onSupport}>
              <Icon name="heart" size={14} /> Support QMax
            </button>
          )}
          <button className="primary" onClick={onClose}>Done</button>
        </>
      }
    >

        <section>
          <h3>Trading</h3>
          <label className="field">
            Default slippage (%)
            <input value={s.slippagePct} inputMode="decimal" onChange={(e) => update({ slippagePct: Number(e.target.value) })} />
            <span className="chips">
              {[0.5, 1, 2, 5].map((v) => (
                <button key={v} className={s.slippagePct === v ? "chip on" : "chip"} onClick={() => update({ slippagePct: v })}>{v}%</button>
              ))}
            </span>
            <small>How far the price may move between the quote and your trade before it is refused. Lower is safer but can fail more often. Capped at 10%.</small>
          </label>
        </section>

        <section>
          <h3>Asset list</h3>
          <label className="check"><input type="checkbox" checked={s.hideQuiet} onChange={(e) => update({ hideQuiet: e.target.checked })} /> Hide quiet assets (no activity for 2 epochs)</label>
          <div className="field">
            Default sort
            <span className="chips">
              <button className={s.defaultSort === "volume" ? "chip on" : "chip"} onClick={() => update({ defaultSort: "volume" })}>Most volume</button>
              <button className={s.defaultSort === "liquidity" ? "chip on" : "chip"} onClick={() => update({ defaultSort: "liquidity" })}>Most liquid</button>
              <button className={s.defaultSort === "az" ? "chip on" : "chip"} onClick={() => update({ defaultSort: "az" })}>A–Z</button>
            </span>
          </div>
          <div className="field">
            Prices on cards
            <span className="chips">
              <button className={s.compactPrices ? "chip on" : "chip"} onClick={() => update({ compactPrices: true })}>Short (8.75B)</button>
              <button className={!s.compactPrices ? "chip on" : "chip"} onClick={() => update({ compactPrices: false })}>Full (8,750,000,000)</button>
            </span>
          </div>
        </section>

        <section>
          <h3>Arbitrage</h3>
          <small className="muted">Arbitrage is part of Max: these limits apply to its flags, filter and search while Max is on.</small>
          <label className="field">
            Only flag if the profit is at least (QU)
            <input value={s.arbMinProfitQu} inputMode="numeric" onChange={(e) => update({ arbMinProfitQu: Number(e.target.value.replace(/,/g, "")) })} />
          </label>
          <label className="field">
            Only flag if the profit is at least (%)
            <input value={s.arbMinProfitPct} inputMode="decimal" onChange={(e) => update({ arbMinProfitPct: Number(e.target.value) })} />
            <small>Profit as a share of the QU you put in. 0 means no minimum.</small>
          </label>
          <label className="field">
            Most QU to put in (your budget)
            <input value={s.arbMaxCostQu} inputMode="numeric" onChange={(e) => update({ arbMaxCostQu: Number(e.target.value.replace(/,/g, "")) })} />
            <small>The search looks for the best arbitrage that fits, instead of the biggest one. 0 means no limit.</small>
          </label>
        </section>

        <section>
          <h3>Max</h3>
          <label className="check">
            <input type="checkbox" checked={max.active} onChange={() => max.toggle()} /> Max mode: search the best position for my trades
          </label>
          <small className="muted">
            Off, Buy, Sell and Swap are the ordinary trades (Swap is QU ⇄ token). On, the order panel gets a Max button (best way to execute, best size, arbitrage, best exit) and Swap can swap any asset ⇄ asset. The Arbitrage filter in the asset list switches it on too{proTitle(max.access)}.
          </small>
          {max.cover?.active && (
            <p className="note first">
              {max.cover.via === "own" ? (
                <>
                  Your Max pass covers {max.cover.covered?.length ?? 1} of {max.cover.coverMax} addresses{max.cover.until ? ` until ${day(Date.parse(max.cover.until))}` : ""}.{" "}
                  <button type="button" className="linklike" onClick={() => setCovering(true)}>Change the list</button>
                </>
              ) : (
                <>This address is covered by a Max pass paid from {short(max.cover.payer ?? "")}{max.cover.until ? ` until ${day(Date.parse(max.cover.until))}` : ""}.</>
              )}
            </p>
          )}
        </section>

        <section>
          <h3>Privacy</h3>
          <label className="check">
            <input type="checkbox" checked={s.shareUsage} onChange={(e) => update({ shareUsage: e.target.checked })} /> Let QMax count my trades and show my membership (it is told the transaction id and your wallet address after each trade, and your address when you open the wallet menu)
          </label>
          <small className="muted">Both are public on the Qubic network anyway. QMax checks each trade against the chain before counting it, and uses the totals to see how many people use it. Turn this off and neither is sent. Features that read your wallet's history for you (History, Your liquidity) still send it when you open them, because they cannot work without it. The page also loads its fonts from Google, and talks to WalletConnect when you connect a wallet.</small>
        </section>

        <section>
          <h3>Share management</h3>
          <label className="check">
            <input type="checkbox" checked={s.consolidate} onChange={(e) => update({ consolidate: e.target.checked })} /> Start with “keep my shares under one contract” ticked when I buy (and offer the move after a sale)
          </label>
          <div className="field">
            Keep them under
            <span className="chips">
              <button className={s.consolidateTo === "qx" ? "chip on" : "chip"} onClick={() => update({ consolidateTo: "qx" })}>QX (default)</button>
              <button className={s.consolidateTo === "qswap" ? "chip on" : "chip"} onClick={() => update({ consolidateTo: "qswap" })}>QSwap</button>
            </span>
            <small>Shares bought on QSwap are managed by QSwap, and QX shares by QX; a market can only trade shares it manages. You are asked each time you buy, so this only sets the starting answer. A sale that needs the other market still moves what it needs first. To move everything at once, use “Keep all under one contract” in My assets.</small>
          </div>
        </section>

    </Modal>
    {covering && max.cover && (
      <CoverModal
        cover={max.cover}
        onClose={() => setCovering(false)}
        onChanged={() => max.refreshPass()}
      />
    )}
    </>
  );
}
