/**
 * The name to show for an asset. Its symbol, except where a smart contract's shares share a name with a token: the contract's id is then NAMESC (QTREATSC, see
 * `AssetCatalog.assignIds`) and that is what is shown for it. Only for display: what goes to the chain (holdings, orders, signing) is always the symbol.
 */
export const shownName = (a: { id: string; symbol: string }): string => (a.id.includes(".") ? a.symbol : a.id);
