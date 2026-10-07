/**
 * A page that hands a WalletConnect pairing link to the wallet app on the same phone. Discord buttons can only
 * open web addresses, so the bot sends people here and this page opens the wallet with its own address scheme.
 *
 * The link travels in the part of the address after the "#", which browsers keep to themselves: it is never sent
 * to this server, so the secret in it does not end up in any log.
 */
export const OPEN_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>Open in your wallet · QMax</title>
<style>
  :root { color-scheme: dark; --bg: #0b0d1a; --card: #151834; --text: #f2f3fb; --muted: #9a9fc0; --accent: #6ee7ff; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: min(440px, 100% - 32px); background: var(--card); border-radius: 16px; padding: 28px 24px; text-align: center; }
  .brand { margin-bottom: 14px; line-height: 0; } .brand svg { width: 52px; height: 54px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 8px 0; color: var(--muted); }
  .btn { display: block; width: 100%; margin-top: 14px; padding: 14px; border-radius: 12px; border: 0; background: var(--accent); color: #05222b; font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
  .btn.ghost { background: transparent; color: var(--text); border: 1px solid #3a3f6b; }
  [hidden] { display: none !important; }
  .err { color: #ff8a8a; }
</style>
</head>
<body>
<main>
  <div class="brand" role="img" aria-label="QMax"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 292 301"><defs><linearGradient id="qx-up" gradientUnits="userSpaceOnUse" x1="28" y1="271" x2="268" y2="34"><stop offset="0" stop-color="#0A8AC6"/><stop offset=".5" stop-color="#33AEA8"/><stop offset="1" stop-color="#24C294"/></linearGradient><linearGradient id="qx-down" gradientUnits="userSpaceOnUse" x1="30" y1="46" x2="251" y2="260"><stop offset="0" stop-color="#1CBBD8"/><stop offset=".4" stop-color="#28B8B3"/><stop offset=".5" stop-color="#33AFA7"/><stop offset=".6" stop-color="#656A69"/><stop offset=".7" stop-color="#984F52"/><stop offset=".8" stop-color="#B33941"/><stop offset=".9" stop-color="#C82B36"/><stop offset="1" stop-color="#D22230"/></linearGradient></defs><path d="M0.5 31 H57.5 L251 234 L269 216 L286 301 L203 285 L223 261 Z" fill="url(#qx-down)"/><path d="M0.5 270 H57.5 L254 68 L276 88 L292 0 L204 15 L225 38 Z" fill="url(#qx-up)"/></svg></div>
  <h1 id="title">Connect your wallet</h1>
  <p id="msg">Tap the button to connect your wallet to QMax.</p>
  <div id="actions">
    <a id="open" class="btn" href="#">Open in Qubic Wallet</a>
    <button id="copy" class="btn ghost" type="button">Copy link instead</button>
  </div>
  <p id="stuck" class="err" hidden>Nothing opened? A phone's in-app browser (the one Discord uses) can refuse to open another app. Open this page in your own browser instead (the browser icon at the bottom of this screen, or the menu, then "Open in Safari" or "Open in Chrome") and tap the button again, or use "Copy link instead" and paste it into your wallet's WalletConnect box.</p>
  <p id="note">Only go on if you pressed Connect in QMax's Discord bot a moment ago. If someone else sent you this link, do not open it: it would connect your wallet to their app. Nothing on this page is sent anywhere: the link stays on your phone.</p>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var raw = "";
  var timer = null;

  function fail(text) {
    $("title").textContent = "This link will not work";
    $("msg").textContent = text;
    $("msg").className = "err";
    $("actions").hidden = true;
    $("note").hidden = true;
  }

  // Reads the link from the address and sets the page up for it. Runs on load and again if the address changes
  // after the "#" (the browser does not reload the page for that, so a second link in the same tab would be missed).
  function render() {
    clearTimeout(timer);
    raw = "";
    try { raw = decodeURIComponent(location.hash.slice(1)); } catch (e) {}
    $("stuck").hidden = true;
    $("title").textContent = "Connect your wallet";
    $("msg").textContent = "Tap the button to connect your wallet to QMax.";
    $("msg").className = "";
    $("actions").hidden = false;
    $("note").hidden = false;
    $("copy").textContent = "Copy link instead";

    if (!/^wc:[0-9a-f]{64}@2\\?/.test(raw) || raw.length > 1500 || raw.indexOf("symKey=") < 0) {
      return fail("This is not a wallet connection link. Go back to Discord and press Connect again.");
    }
    var exp = /[?&]expiryTimestamp=(\\d+)/.exec(raw);
    if (exp && Number(exp[1]) * 1000 < Date.now()) {
      return fail("This connection link has expired. Go back to Discord and press Connect again.");
    }
    // Never opens by itself: this page would pair a wallet with whatever sits after the "#", so only a deliberate tap does it, with the
    // person told what it is. (A link made by someone else could otherwise start a connection to their app the moment it is opened.)
    $("open").href = "qubic-wallet://pairwc/" + raw;
  }

  // The link stays in the address until the wallet has been opened (so "Open in Safari" from an in-app browser carries it along); once the page is
  // left for the wallet it is wiped from the address bar and history, as it has done its job.
  var scrubbed = false;
  function scrub() { if (!scrubbed && location.hash) { scrubbed = true; try { history.replaceState(null, "", location.pathname); } catch (e) {} } }
  var helpTimer = null;
  $("open").addEventListener("click", function (e) {
    if (!raw || /^#?$/.test($("open").getAttribute("href") || "")) return;
    e.preventDefault();
    var left = false;
    var gone = function () { left = true; clearTimeout(helpTimer); scrub(); };
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") gone(); }, { once: true });
    window.addEventListener("pagehide", gone, { once: true });
    location.href = $("open").href;
    clearTimeout(helpTimer);
    // still on the page after a moment: the phone did not open the wallet, so say what to try
    helpTimer = setTimeout(function () { if (!left && document.visibilityState === "visible") $("stuck").hidden = false; }, 2000);
  });

  $("copy").addEventListener("click", function () {
    var text = raw;
    var done = function () { $("copy").textContent = "Copied. Paste it in your wallet's WalletConnect box."; };
    function fallback() {
      var t = document.createElement("textarea");
      t.value = text; t.style.position = "fixed"; t.style.opacity = "0";
      document.body.appendChild(t); t.select();
      try { document.execCommand("copy"); done(); } catch (e) { $("copy").textContent = "Could not copy. Go back to Discord and use Copy link there."; }
      document.body.removeChild(t);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  });

  window.addEventListener("hashchange", function () { if (location.hash) render(); });
  render();
})();
</script>
</body>
</html>
`;

/** The address to put on a Discord button: the page, with the pairing link after the "#". Discord allows 512 characters in a button address. */
export function openLink(base: string, uri: string): string {
  const url = `${base.replace(/\/$/, "")}/open#${encodeURIComponent(uri)}`;
  if (url.length > 512) throw new Error("The pairing link is too long for a Discord button.");
  return url;
}
