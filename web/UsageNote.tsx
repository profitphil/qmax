import { useSettings } from "./settings.tsx";

/** One line before signing: what QMax counts, and that it can be turned off. */
export function UsageNote() {
  const { settings, update } = useSettings();
  return (
    <p className="note usage-note">
      {settings.shareUsage ? (
        <>
          Your signed order goes to the network through QMax, which notes its transaction id (public on-chain data) to count orders made here.{" "}
          <button type="button" className="link" onClick={() => update({ shareUsage: false })}>Turn off</button>
        </>
      ) : (
        <>
          Counting is off: your order goes straight to the network and QMax is not told about it.{" "}
          <button type="button" className="link" onClick={() => update({ shareUsage: true })}>Turn on</button>
        </>
      )}
    </p>
  );
}
