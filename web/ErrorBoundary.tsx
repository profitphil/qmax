import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

/**
 * Catches a crash anywhere below it and shows a plain page instead of a blank one. A blank page is worse than it sounds here: a signing flow
 * that was running keeps going with nothing on screen to show what it is doing (the flows also stop themselves when their window is removed,
 * see exec/abort.ts, but a person should never be left looking at nothing).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean; detail: string }> {
  state = { failed: false, detail: "" };

  static getDerivedStateFromError(error: unknown) {
    // What went wrong, in a line, for the person to read out or screenshot: the kind of error and its message, no page state.
    const e = error as { name?: string; message?: string } | null;
    return { failed: true, detail: `${e?.name ?? "Error"}: ${String(e?.message ?? error).slice(0, 220)}` };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The page and the message only: nothing from the page's state (it can hold a wallet address) is logged or sent anywhere.
    console.error("QMax crashed:", error.message, info.componentStack?.split("\n").slice(0, 3).join(" "));
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main style={{ maxWidth: 520, margin: "20vh auto", padding: "0 20px", textAlign: "center", color: "var(--fg, inherit)" }}>
        <h1 style={{ fontSize: 22 }}>Something went wrong</h1>
        <p>QMax hit an error and stopped what it was doing. Nothing more will be signed. If you were in the middle of a trade, check your wallet or the explorer for what went through before you try again.</p>
        <button className="primary" onClick={() => window.location.reload()}>Reload</button>
        {this.state.detail && <p style={{ marginTop: 18, fontSize: 12, opacity: 0.6, wordBreak: "break-word" }}>{this.state.detail}</p>}
      </main>
    );
  }
}
