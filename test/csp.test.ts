import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/** The policy as vite.config.ts builds it: the quoted lines of the `CSP` array joined with "; ". */
function policyInViteConfig(): string {
  const src = read("vite.config.ts");
  const body = src.slice(src.indexOf("export const CSP = ["), src.indexOf("].join(\"; \")"));
  return [...body.matchAll(/^\s*"([^"]+)",?\s*$/gm)].map((m) => m[1]).join("; ");
}

const policyInHeadersFile = () => read("web/public/_headers").match(/Content-Security-Policy: (.+)/)![1].trim();
// The server's own files (deploy/) are not in the public copy of the repository: the tests that read them are skipped there.
const skipNoDeploy = existsSync(new URL("../deploy/nginx-qmax.conf", import.meta.url)) ? false : "deploy/ is not in this copy";
const policyInNginxSnippet = () => read("deploy/nginx-snippets/qmax-csp.conf").match(/add_header Content-Security-Policy "([^"]+)" always;/)![1];

test("the Content-Security-Policy is the same text in vite.config.ts and _headers", () => {
  const vite = policyInViteConfig();
  assert.ok(vite.includes("default-src 'none'"), "could not read the policy from vite.config.ts");
  assert.equal(policyInHeadersFile(), vite);
});

test("the nginx snippet carries the same Content-Security-Policy", { skip: skipNoDeploy }, () => {
  assert.equal(policyInNginxSnippet(), policyInViteConfig());
});

test("the policy lets WalletConnect's Verify page be framed (blocked, the connection link takes five seconds longer)", () => {
  const csp = policyInViteConfig();
  assert.match(csp, /frame-src https:\/\/verify\.walletconnect\.org https:\/\/verify\.walletconnect\.com/);
  assert.match(csp, /frame-ancestors 'none'/); // and this page may not be framed
  const scripts = csp.split("; ").find((d) => d.startsWith("script-src "))!.split(" ").slice(1);
  assert.deepEqual(scripts, ["'self'", "'wasm-unsafe-eval'"]); // no inline script, no eval; WebAssembly only, which the wallet library uses
});

test("every location in the site's nginx config that sets a header of its own also includes the security headers", { skip: skipNoDeploy }, () => {
  const conf = read("deploy/nginx-qmax.conf");
  // nginx passes a server's add_header into a location only when the location has none of its own, so a location that sets Cache-Control sends no security headers unless it includes them.
  for (const m of conf.matchAll(/\n    location ([^{]+)\{([\s\S]*?)\n    \}/g)) {
    const [, name, body] = m;
    if (!/add_header/.test(body)) continue;
    assert.match(body, /include snippets\/qmax-security-headers\.conf;/, `location ${name.trim()} sets a header but does not include the security headers`);
  }
  // the page locations carry the policy too
  for (const name of ["/assets/", "/"]) {
    const body = conf.match(new RegExp(`\\n    location ${name.replace("/", "\\/")} \\{([\\s\\S]*?)\\n    \\}`))![1];
    assert.match(body, /include snippets\/qmax-csp\.conf;/, `location ${name} lacks the policy`);
  }
  assert.doesNotMatch(read("deploy/nginx-snippets/qmax-security-headers.conf"), /Content-Security-Policy/);
});

test("deploy.sh installs both snippets", { skip: skipNoDeploy }, () => {
  const deploy = read("deploy/deploy.sh");
  for (const f of ["qmax-security-headers.conf", "qmax-csp.conf"]) assert.match(deploy, new RegExp(`install -m 644 deploy/nginx-snippets/${f.replace(".", "\\.")} /etc/nginx/snippets/${f.replace(".", "\\.")}`));
});
