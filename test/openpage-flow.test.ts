import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { OPEN_PAGE_HTML } from "../src/openpage.ts";

const URI = "wc:" + "a".repeat(64) + "@2?expiryTimestamp=4102444800&relay-protocol=irn&symKey=" + "b".repeat(64);
const ORIGIN = "https://qmax.exchange";

interface El { textContent: string; className: string; hidden: boolean; href: string; getAttribute(n: string): string | null; addEventListener(t: string, f: (e: unknown) => void): void; click(): void }

/** Runs the page's own script against a minimal browser and returns what a person would see and what it did. */
function load(search: string, hash = "#" + encodeURIComponent(URI), stored: Record<string, string> = {}) {
  const script = /<script>([\s\S]*?)<\/script>/.exec(OPEN_PAGE_HTML)![1];
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const on = (target: Record<string, ((e: unknown) => void)[]>) => (t: string, f: (e: unknown) => void) => void (target[t] = [...(target[t] ?? []), f]);
  const els: Record<string, El> = {};
  const el = (id: string): El => {
    const own: Record<string, ((e: unknown) => void)[]> = {};
    return (els[id] ??= {
      textContent: "", className: "", hidden: false, href: "",
      getAttribute(n) { return n === "href" ? this.href : null; },
      addEventListener: on(own),
      click() { (own.click ?? []).forEach((f) => f({ preventDefault() {} })); },
    });
  };
  const timers: { fn: () => void; ms: number }[] = [];
  const docListeners: Record<string, ((e: unknown) => void)[]> = {};
  const winListeners: Record<string, ((e: unknown) => void)[]> = {};
  const document = { visibilityState: "visible", getElementById: el, addEventListener: on(docListeners), createElement: () => ({ style: {}, select() {} }), body: { appendChild() {}, removeChild() {} }, execCommand: () => true };
  const calls = { navigated: [] as string[], replaced: [] as string[], scrubbed: 0, address: [] as string[] };
  const session = new Map<string, string>(Object.entries(stored));
  const location = {
    hash, search, origin: ORIGIN, pathname: "/api/open",
    set href(v: string) { calls.navigated.push(v); },
    get href() { return ""; },
    replace(v: string) { calls.replaced.push(v); },
  };
  const ctx = vm.createContext({
    document, location, URLSearchParams, decodeURIComponent, Date, Number, RegExp,
    window: { addEventListener: on(winListeners) },
    history: { replaceState(_a: unknown, _b: unknown, url: string) { calls.scrubbed++; calls.address.push(url); } },
    sessionStorage: { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => void session.set(k, v), removeItem: (k: string) => void session.delete(k) },
    navigator: {},
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
    clearTimeout: () => {},
  });
  vm.runInContext(script, ctx);
  const fire = (t: string, state?: string) => {
    if (state) document.visibilityState = state;
    (docListeners[t] ?? []).forEach((f) => f({}));
  };
  /** The person taps Open, the phone goes to the wallet app, and they come back. */
  const goToWalletAndBack = () => {
    els.open.click();
    fire("visibilitychange", "hidden");
    fire("visibilitychange", "visible");
  };
  return { els, calls, timers, fire, winListeners, goToWalletAndBack, document, session };
}

test("opening the wallet hands over the link, and the first screen offers only that", () => {
  const p = load("?return=%2F");
  assert.equal(p.els.open.href, "qubic-wallet://pairwc/" + URI);
  assert.equal(p.els.actions.hidden, false);
  p.els.open.click();
  assert.deepEqual(p.calls.navigated, ["qubic-wallet://pairwc/" + URI]);
  assert.equal(p.els.done.hidden, true, "nothing about going back yet");
});

test("from the QMax website: back from the wallet, the page says so and takes the person back to QMax", () => {
  const p = load("?return=%2F");
  p.goToWalletAndBack();
  assert.equal(p.calls.scrubbed, 1, "the link is wiped from the address once the page is left for the wallet");
  assert.deepEqual(p.calls.address, ["/api/open?return=%2F"], "...but the way back stays in it, for a page the phone reloads");
  assert.equal(p.session.get("qmax.open.spent"), "1");
  assert.equal(p.els.title.textContent, "Back from your wallet?");
  assert.match(p.els.msg.textContent, /QMax picks it up now/);
  assert.equal(p.els.done.textContent, "Back to QMax");
  assert.equal(p.els.done.href, ORIGIN + "/");
  assert.equal(p.els.done.hidden, false);
  assert.equal(p.els.actions.hidden, true, "the spent Open and Copy buttons are gone");
  assert.equal(p.els.note.hidden, true);
  assert.equal(p.calls.replaced.length, 0, "not at once: the person is told first");
  const go = p.timers.find((t) => t.ms === 1500);
  assert.ok(go, "it goes back by itself after a moment");
  go!.fn();
  assert.deepEqual(p.calls.replaced, [ORIGIN + "/"]);
});

test("from Discord (no way back asked for): the page says to return to Discord and never leaves by itself", () => {
  const p = load("");
  p.goToWalletAndBack();
  assert.equal(p.els.title.textContent, "Back from your wallet?");
  assert.match(p.els.msg.textContent, /Discord/);
  assert.match(p.els.msg.textContent, /\/wallet/);
  assert.equal(p.els.done.textContent, "Open Discord");
  assert.equal(p.els.done.href, "https://discord.com/channels/@me");
  assert.equal(p.timers.some((t) => t.ms === 1500), false);
  assert.equal(p.calls.replaced.length, 0);
});

test("the way back can only be this site's front page: nothing else in ?return= is followed", () => {
  for (const bad of [
    "?return=https%3A%2F%2Fevil.example%2F", // another site
    "?return=%2F%2Fevil.example", // protocol-relative
    "?return=%2F%5Cevil.example", // backslash trick
    "?return=javascript%3Aalert(1)",
    "?return=%2Fapi%2Fv1%2Fkeys", // another path on this site
    "?return=%2F%3Fa%3D%3Cscript%3E", // markup in the query
    "?return=%2F%3F" + "a".repeat(200), // too long
    "?return=",
  ]) {
    const p = load(bad);
    p.goToWalletAndBack();
    assert.equal(p.els.done.textContent, "Open Discord", `${bad} was treated as a way back`);
    assert.equal(p.calls.replaced.length, 0, bad);
  }
  // but the front page with a plain query is fine
  const ok = load("?return=%2F%3Fasset%3DQMINE");
  ok.goToWalletAndBack();
  assert.equal(ok.els.done.href, ORIGIN + "/?asset=QMINE");
});

test("nothing changes if the page was never left for the wallet, or the link was no good", () => {
  const p = load("?return=%2F");
  p.fire("visibilitychange", "hidden"); // the phone's screen went off, say, without the wallet being opened
  p.fire("visibilitychange", "visible");
  assert.equal(p.els.title.textContent, "Connect your wallet");
  assert.equal(p.els.done.hidden, true);
  assert.equal(p.els.actions.hidden, false);
  const bad = load("?return=%2F", "#nonsense");
  assert.equal(bad.els.title.textContent, "This link will not work");
  assert.equal(bad.els.actions.hidden, true);
});

test("a Home Screen web app has no back button: the first screen offers a way out to QMax (only when the site asked for a way back)", () => {
  const site = load("?return=%2F");
  assert.equal(site.els.cancel.hidden, false);
  assert.equal(site.els.cancel.href, ORIGIN + "/");
  assert.match(site.els.cancel.textContent || "Not now: back to QMax", /back to QMax/);
  assert.equal(load("").els.cancel.hidden, true, "from Discord there is no QMax page to go back to");
  assert.equal(load("?return=https%3A%2F%2Fevil.example%2F").els.cancel.hidden, true);
});

test("the phone reloads the page while the wallet is open (the link is gone from the address): the site's page goes back to QMax instead of calling it a bad link", () => {
  const p = load("?return=%2F", ""); // what the address is after the link was wiped
  assert.equal(p.els.title.textContent, "Back from your wallet?");
  assert.match(p.els.msg.textContent, /QMax picks it up now/);
  assert.equal(p.els.done.href, ORIGIN + "/");
  assert.equal(p.els.done.hidden, false);
  assert.equal(p.els.actions.hidden, true);
  assert.equal(p.calls.replaced.length, 0);
  p.timers.find((t) => t.ms === 1500)!.fn();
  assert.deepEqual(p.calls.replaced, [ORIGIN + "/"]);
});

test("the same reload from Discord (no way back asked for) says to return to Discord, but only if this tab did use a link; a bare visit is still a bad link", () => {
  const after = load("", "", { "qmax.open.spent": "1" });
  assert.equal(after.els.title.textContent, "Back from your wallet?");
  assert.match(after.els.msg.textContent, /Discord/);
  assert.equal(after.els.done.textContent, "Open Discord");
  assert.equal(after.calls.replaced.length, 0);
  const bare = load("", "");
  assert.equal(bare.els.title.textContent, "This link will not work");
  assert.match(bare.els.msg.textContent, /not a wallet connection link/);
});

test("a fresh link in a tab that used one before is a fresh start, not a 'back from your wallet' screen", () => {
  const p = load("?return=%2F", undefined, { "qmax.open.spent": "1" });
  assert.equal(p.els.title.textContent, "Connect your wallet");
  assert.equal(p.els.actions.hidden, false);
  assert.equal(p.els.done.hidden, true);
  assert.equal(p.session.has("qmax.open.spent"), false, "the old mark is cleared");
});
