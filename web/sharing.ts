import { sanitizeSettings } from "../src/settings.ts";

/**
 * The person's choice in Settings (on unless they turned it off): whether QMax may be told about their trades and look up their wallet's
 * membership. Read straight from storage so it works outside React, and so that when it cannot be read the answer is the default (on).
 */
export function usageSharingOn(): boolean {
  try {
    return sanitizeSettings(JSON.parse(localStorage.getItem("qmax.settings") ?? "{}")).shareUsage;
  } catch {
    return true;
  }
}
