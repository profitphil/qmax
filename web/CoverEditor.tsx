import { COVER_MAX } from "../src/procover.ts";
import { checkCover } from "./cover.ts";
import { Icon } from "./ui.tsx";

interface Props {
  payer: string;
  value: string;
  onChange: (text: string) => void;
  disabled?: boolean;
  /** Accounts the wallet has beyond the ones prefilled. */
  skipped?: number;
}

/**
 * The addresses a Max pass covers, one per line. The paying address is always covered, so it is not listed here. Public addresses only: a seed pasted by
 * mistake is refused with a warning and is never sent anywhere.
 */
export function CoverEditor({ payer, value, onChange, disabled, skipped = 0 }: Props) {
  const check = checkCover(payer, value);
  const count = check.ok ? check.list.length : null;
  return (
    <div className="cover-editor">
      <label className="cover-label" htmlFor="cover-list">
        Other addresses this pass covers <small>(optional, up to {COVER_MAX - 1})</small>
      </label>
      <textarea
        id="cover-list"
        className="cover-text"
        rows={4}
        spellCheck={false}
        autoCapitalize="characters"
        autoComplete="off"
        placeholder="One public address per line"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      {check.ok ? (
        <p className="note first">
          {count === 1 ? "Covers this address only." : `Covers this address and ${count! - 1} more (${count} of ${COVER_MAX}).`}
          {skipped > 0 && ` Your wallet has ${skipped} more account${skipped === 1 ? "" : "s"} than fit.`}
        </p>
      ) : (
        <p className="err inline"><Icon name="alert" size={15} /> {check.error}</p>
      )}
    </div>
  );
}
