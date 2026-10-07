import { COVER_MAX, normalizeCover } from "../src/procover.ts";

/** The addresses typed or pasted: split on spaces, new lines, commas and semicolons. */
export const splitAddresses = (text: string): string[] => text.split(/[\s,;]+/).filter(Boolean);

/** What to prefill the list with: the wallet's other accounts, as many as fit beside the payer. */
export function prefillCover(payer: string, accounts: string[] | undefined): { text: string; skipped: number } {
  const others = [...new Set((accounts ?? []).filter((a) => a !== payer))];
  const take = others.slice(0, COVER_MAX - 1);
  return { text: take.join("\n"), skipped: others.length - take.length };
}

export type CoverCheck = { ok: true; list: string[] } | { ok: false; error: string };

/** The list the text makes with the payer in it, or the sentence that says what is wrong with it. */
export function checkCover(payer: string, text: string): CoverCheck {
  return normalizeCover(splitAddresses(text), payer);
}
