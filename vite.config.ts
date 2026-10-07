import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// In dev, /api is proxied to the QMax API (npm run api). In production, serve the API under /api
// or set VITE_API_URL.
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Headers that are right for any page of this site, in development and in production. */
const baseHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY", // the wallet page must not be framed (clickjacking)
  "Referrer-Policy": "no-referrer",
};

/**
 * The Content-Security-Policy production should serve (the same text is in web/public/_headers). Only this site's own scripts (no inline,
 * no eval; WebAssembly is allowed because the wallet library uses it), styles from Google Fonts, connections to the Qubic RPC, the
 * WalletConnect relay and this origin. If the API is served from another origin, add it to connect-src.
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https://rpc.qubic.org https://relay.walletconnect.org wss://relay.walletconnect.org https://rpc.walletconnect.org https://verify.walletconnect.org https://verify.walletconnect.com https://pulse.walletconnect.org https://echo.walletconnect.com",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export default defineConfig({
  root: "web",
  // The one .env lives at the repo root (same file the API and bot read via --env-file-if-exists=.env), not
  // under web/. Vite's default envDir follows `root`, so without this, every VITE_* var in .env — pricing,
  // the WalletConnect project id — is silently invisible to the build: it falls back to hardcoded defaults
  // with no error, which is easy to miss until a setting you changed turns out to have never taken effect.
  envDir: here("."), // vite.config.ts already sits at the repo root (beside .env), not one level inside it
  plugins: [react()],
  server: {
    proxy: { "/api": { target: "http://127.0.0.1:8787", rewrite: (p) => p.replace(/^\/api/, "") } },
    headers: baseHeaders, // the development server's hot reload needs inline script, so the full policy is for vite preview and production
    // The development server serves files from disk by path (/@fs/...), by default from anywhere in the repository, which includes .cache/ (balances,
    // wallet-session data, ledgers). It may read the site's own code and nothing else, and it sends no CORS headers: only this page talks to it.
    fs: { allow: [here("./web"), here("./src"), here("./node_modules")], deny: [".env", ".env.*", "**/.cache/**", "*.{crt,pem,key}"] },
    cors: false,
  },
  preview: { headers: { ...baseHeaders, "Content-Security-Policy": CSP }, cors: false },
});
