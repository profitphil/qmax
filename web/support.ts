import { useEffect, useState } from "react";
import { fetchPlans } from "./client.ts";

let tipJar: Promise<string> | null = null;
/** The Q+Pay tip jar link QMax's server gives out, read once ("" while there is none, or the server could not be reached: then it is tried again next time). */
const readTipJar = () =>
  (tipJar ??= fetchPlans().then((p) => {
    if (!p) tipJar = null;
    return p?.supportUrl ?? "";
  }));

/** The tip jar link for the heart in the title bar: "" until it is known, and for good where QMax has no tip jar (the heart then opens the Support window). */
export function useTipJarUrl(): string {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let live = true;
    readTipJar().then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, []);
  return url;
}
