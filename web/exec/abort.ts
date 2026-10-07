import { useEffect, useRef } from "react";

/**
 * A signal that is aborted when the component using it goes away. Hand it to `runSteps`, so that closing the window (or a crash that removes
 * it) stops a trade between its steps instead of leaving the remaining ones to be signed with nothing on screen.
 * It is made when the component mounts, so a development double-mount cannot leave it already aborted.
 */
export function useCloseSignal(): () => AbortSignal | undefined {
  const ref = useRef<AbortController | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    ref.current = ctl;
    return () => ctl.abort();
  }, []);
  return () => ref.current?.signal;
}
