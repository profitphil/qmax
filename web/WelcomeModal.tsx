import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { fetchPlans } from "./client.ts";
import type { AgentPlan, DiscordPlan } from "./client.ts";
import { Icon, Logo, LogoMark, Modal } from "./ui.tsx";
import type { IconName } from "./ui.tsx";

const KEY = "qmax.welcome.off";
/** Whether the window was switched off with "Don't show this again" (kept in this browser). */
export function welcomeOff(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
const setOff = (off: boolean) => {
  try {
    if (off) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    // not remembered: it shows again next time
  }
};

/** "MAX" with the colored X beside it, the way Max shows beside its features: here it always shows, whatever the Settings say about the marks. */
const Max = () => (
  <span className="welcome-max">
    MAX
    <LogoMark size={11} />
  </span>
);

const n = (x: number) => x.toLocaleString("en-US");
/** "an hour", "2 hours", "30 minutes": how long a session lasts, in a sentence. */
const spanOf = (seconds: number) => (seconds === 3600 ? "an hour" : seconds % 3600 === 0 ? `${seconds / 3600} hours` : `${Math.round(seconds / 60)} minutes`);

/**
 * What agents pay, from the server's own settings (`/v1/plans`), so this never says a price that is no longer true. The price is per plan; it is paid from a prepaid
 * balance (the smallest top-up buys this many plans) or by a session that covers unlimited plans. Nothing is said until the server has answered.
 */
function agentCharge(a: AgentPlan | null): ReactNode {
  if (!a) return null;
  if (!a.maxPriceQu) return " It is free for agents too.";
  const prepaid = a.minTopupQu && a.minTopupQu >= a.maxPriceQu ? `prepay ${n(a.minTopupQu)} QU for ${n(Math.floor(a.minTopupQu / a.maxPriceQu))} of them` : "";
  const session = a.sessionPriceQu && a.sessionSeconds ? `${n(a.sessionPriceQu)} QU for ${spanOf(a.sessionSeconds)} of unlimited ones` : "";
  const ways = [prepaid, session].filter(Boolean).join(", or ");
  return (
    <>
      {" "}
      Agents are charged {n(a.maxPriceQu)} QU for each <Max /> best position{ways ? `: ${ways}` : ""}.
    </>
  );
}

/** The Discord bot line: alerts are the one paid part (the bot checks the market for each alert about every minute), from `/v1/plans`. */
function discordText(d: DiscordPlan | null): ReactNode {
  if (d?.alertsPriceQu) {
    return (
      <>
        Quotes, charts and trades from Discord are free. Alerts (price, arbitrage and big trades, checked every minute, each with a one-tap trade) cost {n(d.alertsPriceQu)} QU for {d.days} days.
      </>
    );
  }
  return "Quotes, charts, alerts and trades from Discord, free for everyone too.";
}

const features = (agents: AgentPlan | null): { icon: IconName; title: ReactNode; text: ReactNode }[] => [
  {
    icon: "layers",
    title: "Best price, automatically",
    text: (
      <>
        QMax compares QX and QSwap and can split your order across both, so you get <Max /> for your QU.
      </>
    ),
  },
  {
    icon: "chart",
    title: (
      <>
        <Max /> Charts (QX and QSwap)
      </>
    ),
    text: "Live candles, indicators, drawing tools, timeframes 1m to 1 Day, for every asset.",
  },
  {
    icon: "swap",
    title: "Swap",
    text: (
      <>
        QU ⇄ token. <Max /> swap any asset ⇄ asset.
      </>
    ),
  },
  { icon: "book", title: "Portfolio", text: "What your holdings would really fetch if sold now, what they cost you, profit and loss, open orders and history." },
  { icon: "inbox", title: "Pools", text: "Every QSwap pool, ranked by the fees it really earns." },
  {
    icon: "bot",
    title: "Agent trading using Q+Pay's (x402) payment rails.",
    text: (
      <>
        AI agents trade here as easily as people, with no account needed: an API (<a href="/api/v1/openapi.json" target="_blank" rel="noopener noreferrer">spec</a>), an MCP server and an SDK.{agentCharge(agents)}
      </>
    ),
  },
  { icon: "bolt", title: "On your phone", text: "Swipe between assets, chart, trades and your portfolio." },
];

/**
 * The window shown when the site loads: what QMax does, in a few plain lines, a way to support it, and a box to stop showing it. QMax is free for everyone.
 */
export function WelcomeModal({ onClose, onSupport }: { onClose: () => void; onSupport: () => void }) {
  const [off, setOffState] = useState(welcomeOff);
  const [agents, setAgents] = useState<AgentPlan | null>(null);
  const [discord, setDiscord] = useState<DiscordPlan | null>(null);
  useEffect(() => {
    let alive = true;
    fetchPlans().then((p) => {
      if (!alive || !p) return;
      setAgents(p.agents);
      setDiscord(p);
    });
    return () => {
      alive = false;
    };
  }, []);
  return (
    <Modal
      title={
        <>
          Welcome to <Logo />
        </>
      }
      subtitle="The best route for your Qubic trades. Free for everyone, with no fees, and you keep your keys: every trade is signed in your own wallet."
      size="md"
      className="welcome"
      onClose={onClose}
      footer={
        <div className="welcome-foot">
          <label className="welcome-off">
            <input
              type="checkbox"
              checked={off}
              onChange={(e) => {
                setOffState(e.target.checked);
                setOff(e.target.checked);
              }}
            />
            Don't show this again
          </label>
          <div className="welcome-actions">
            <button type="button" className="ghost" onClick={onSupport}>
              <Icon name="heart" size={14} /> Support QMax
            </button>
            <button type="button" className="primary" onClick={onClose}>
              Start trading
            </button>
          </div>
        </div>
      }
    >
      <ul className="welcome-list">
        {features(agents).map((f) => (
          <li key={String(f.icon)}>
            <span className="welcome-ic" aria-hidden="true">
              <Icon name={f.icon} size={16} />
            </span>
            <span>
              <b>{f.title}</b> {f.text}
            </span>
          </li>
        ))}
        <li className="welcome-discord">
          <span className="welcome-ic" aria-hidden="true">
            <Icon name="inbox" size={16} />
          </span>
          <span>
            <b>Discord bot</b> {discordText(discord)}
          </span>
        </li>
      </ul>
    </Modal>
  );
}
