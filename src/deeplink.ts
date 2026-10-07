/** A link into the QMax trade screen with the order already filled in, for other sites to send their users to. */
export interface DeepLink {
  asset: string;
  side: "buy" | "sell";
  qty?: number;
  /** Who sent the user (a partner's tag), for counting only. */
  ref?: string;
}

// An asset id: a name on the chain (up to 7 letters or digits), or one with SC after it (QTREATSC: a contract's shares that share their name with a token).
const ASSET = /^[A-Za-z0-9]{1,9}$/;
const REF = /^[A-Za-z0-9_-]{1,32}$/;

// Names that are also properties of every object: as a key in a table of partners they would do something other than name a partner.
const RESERVED = new Set(["__proto__", "constructor", "prototype", "tostring", "valueof", "hasownproperty"]);

export const isRef = (v: unknown): v is string => typeof v === "string" && REF.test(v) && !RESERVED.has(v.toLowerCase());

/** Reads `?asset=CFB&side=buy&qty=1000&ref=qubictrade`. Anything invalid is dropped; no asset means no link. */
export function parseDeepLink(search: string): DeepLink | null {
  const p = new URLSearchParams(search);
  const asset = p.get("asset")?.trim() ?? "";
  if (!ASSET.test(asset)) return null;
  const qty = Number((p.get("qty") ?? "").replace(/,/g, ""));
  const ref = p.get("ref") ?? "";
  return {
    asset: asset.toUpperCase(),
    side: p.get("side") === "sell" ? "sell" : "buy",
    ...(Number.isInteger(qty) && qty > 0 && qty <= 1e12 ? { qty } : {}),
    ...(isRef(ref) ? { ref } : {}),
  };
}

/** The link to send a user to: `base` is where QMax is served, e.g. "https://qmax.example". */
export function buildDeepLink(base: string, link: DeepLink): string {
  if (!ASSET.test(link.asset)) throw new Error("asset must be 1-9 letters or digits");
  const q = new URLSearchParams({ asset: link.asset.toUpperCase(), side: link.side });
  if (link.qty !== undefined) {
    if (!Number.isInteger(link.qty) || link.qty <= 0 || link.qty > 1e12) throw new Error("qty must be a positive whole number");
    q.set("qty", String(link.qty));
  }
  if (link.ref !== undefined) {
    if (!isRef(link.ref)) throw new Error("ref must be 1-32 letters, digits, - or _");
    q.set("ref", link.ref);
  }
  return `${base.replace(/\/$/, "")}/?${q}`;
}
