import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Reading and writing the small JSON state files (balances, ledgers, caches) safely:
 *  - a file that is there but cannot be read, or has the wrong shape, is moved aside (never silently replaced by an empty one, which would
 *    throw away balances or payment records on the next save) and the caller starts empty with a loud message;
 *  - a write goes to a temporary file that is renamed over the real one, so a crash cannot leave half a file;
 *  - files are owner-only (0600) in an owner-only directory (0700): they hold balances, wallet addresses, session data and the like.
 */

let moved = 0;

/** The parsed file, or undefined when there is none (first run) or it was unusable (moved aside to `<file>.corrupt-<time>`). */
export function readJsonFile<T = unknown>(file: string, check?: (v: unknown) => boolean): T | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined; // not there yet
  }
  try {
    const v = JSON.parse(text) as unknown;
    if (check && !check(v)) throw new Error("it does not have the expected shape");
    return v as T;
  } catch (e) {
    const aside = `${file}.corrupt-${Date.now()}-${++moved}`;
    try {
      renameSync(file, aside);
    } catch {
      // nothing more can be done about it
    }
    console.error(`${file} could not be used (${e instanceof Error ? e.message : e}). It was moved to ${aside} and this starts empty: look at the old file before deleting it.`);
    return undefined;
  }
}

/** Writes `data` as JSON, atomically, owner-only. */
export function writeJsonFile(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  if (existsSync(tmp)) unlinkSync(tmp); // a leftover with looser permissions would keep them
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** True for a plain object (not null, not an array). */
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
