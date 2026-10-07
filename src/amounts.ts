/**
 * The quick-amount buttons on the order panel. Smart contract shares are few (676 of each), so their buttons are small numbers; a
 * community token has billions of units and trades in the hundreds of thousands, so its buttons are big ones.
 */
export const CONTRACT_PRESETS: readonly number[] = [1, 2, 5, 10];
export const TOKEN_PRESETS: readonly number[] = [100_000, 500_000, 1_000_000, 10_000_000];

export const presetsFor = (category: "contract" | "token"): readonly number[] => (category === "contract" ? CONTRACT_PRESETS : TOKEN_PRESETS);

/** 100000 becomes "100K", 10000000 becomes "10M", 5 stays "5". */
export const presetLabel = (n: number): string => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
