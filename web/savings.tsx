import { useState } from "react";
import { addToTally, comparisonLines, receiptText, routeSaving, savingHeadline, tallyLine } from "../src/savings.ts";
import type { RouteSaving, SavingsInput, SavingsTally } from "../src/savings.ts";
import { Icon } from "./ui.tsx";

const KEY = "qmax.savings";

function readAll(): Record<string, SavingsTally> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}

/** What routing has saved this wallet so far (kept in this browser only). */
export function loadTally(wallet: string): SavingsTally | undefined {
  return readAll()[wallet];
}

/** Counts a finished trade for this wallet and returns the new total. `filledFraction` is how much of the order really filled. */
export function recordTrade(wallet: string, saving: RouteSaving, filledFraction: number): SavingsTally {
  const next = addToTally(readAll()[wallet], saving, filledFraction);
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [wallet]: next }));
  } catch {
    // storage blocked: the total then lasts only until the page is closed
  }
  return next;
}

/** In the quote: what the route is worth against each market alone. Shows nothing when there is nothing worth saying. */
export function SavingsLine({ quote }: { quote: SavingsInput }) {
  const saving = routeSaving(quote);
  const head = saving && savingHeadline(saving);
  if (!saving || !head) return null;
  return (
    <div className="saving">
      <Icon name="bolt" size={15} fill />
      <div>
        <b>{head}</b>
        <ul className="saving-lines">
          {comparisonLines(saving).map((l) => <li key={l}>{l}</li>)}
        </ul>
        <small className="muted">Each market on its own, for the whole order, at the prices quoted now.</small>
      </div>
    </div>
  );
}

/** After a trade: what the route was worth, the running total, and a line to copy and share. */
export function SavingsReceipt({ saving, side, asset, filledQty, actualQu, tally }: { saving: RouteSaving | null; side: "buy" | "sell"; asset: string; filledQty: number; actualQu: number; tally: SavingsTally | undefined }) {
  const [copied, setCopied] = useState(false);
  const head = saving ? savingHeadline(saving) : null;
  const total = tallyLine(tally);
  if (!head && !total) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(receiptText({ side, asset, filledQty, actualQu, saving }));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked: nothing to do, the text is on screen
    }
  };
  return (
    <div className="saving receipt">
      <Icon name="bolt" size={15} fill />
      <div>
        {head && <b>{head}</b>}
        {head && <small className="muted">Measured at the prices quoted before you signed; your actual result is above.</small>}
        {total && <p className="saving-total">{total}</p>}
        {filledQty > 0 && (
          <button className="link" onClick={copy}>
            <Icon name={copied ? "check" : "copy"} size={13} /> {copied ? "Copied" : "Copy receipt"}
          </button>
        )}
      </div>
    </div>
  );
}
