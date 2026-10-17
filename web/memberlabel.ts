/**
 * The words for a wallet's membership in the wallet menu, from what `GET /v1/membership` really answers. That answer leaves out which Discord accounts paid for the wallet
 * (the owner's to see, not anyone's who knows a wallet address: src/shareapi.ts removes `discordIds`), so nothing here may read it, and the pieces that are optional are
 * read with care. The menu used to read `discordIds.length`, which broke the whole page for every subscriber the moment they opened their wallet menu.
 */
export interface MemberLike {
  active: boolean;
  until?: number | null;
  source?: "subscription" | "pass" | null;
  profitShare?: { earnedQu?: number; paidQu?: number; owedQu?: number; thisMonth?: { estimatedQu?: number } } | null;
}

/** How the wallet is a member: what keeps it active, or that it is not one right now. */
export function memberHow(m: Pick<MemberLike, "source">): string {
  return m.source === "subscription" ? "Subscriber" : m.source === "pass" ? "Pass holder" : "Not a member right now";
}

/** Whether the wallet has earned, been paid or is expected to earn any profit share, so the figures are worth showing. */
export function hasProfitShare(m: Pick<MemberLike, "profitShare">): boolean {
  const s = m.profitShare;
  return !!s && ((s.earnedQu ?? 0) > 0 || (s.paidQu ?? 0) > 0 || (s.thisMonth?.estimatedQu ?? 0) > 0);
}

/** Whether the membership block shows at all: a member, or someone with profit share to show. */
export const showsMembership = (m: MemberLike): boolean => m.active || hasProfitShare(m);
