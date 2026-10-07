import { useSettings } from "./settings.tsx";

/** One line before signing: what QMax counts, and that it can be turned off. */
export function UsageNote() {
  const { settings, update } = useSettings();
  return (
    <p className="note usage-note">
      {settings.shareUsage ? (
        <>
          QMax counts the transaction ids of trades made here, which are public on-chain data, to measure usage.{" "}
          <button type="button" className="link" onClick={() => update({ shareUsage: false })}>Turn off</button>
        </>
      ) : (
        <>
          Usage counting is off: QMax is not told about your trades.{" "}
          <button type="button" className="link" onClick={() => update({ shareUsage: true })}>Turn on</button>
        </>
      )}
    </p>
  );
}
