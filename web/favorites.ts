import { useCallback, useState } from "react";

const KEY = "qmax.favorites";

const read = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return []; // storage can be blocked (private windows); favorites then last for the session only
  }
};

/** Starred asset ids, remembered in this browser. */
export function useFavorites() {
  const [ids, setIds] = useState<string[]>(read);
  const toggle = useCallback((id: string) => {
    setIds((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);
  return { ids, has: (id: string) => ids.includes(id), toggle };
}
