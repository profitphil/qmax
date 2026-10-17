import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * What a search engine or an AI assistant's fetcher reads without running the app: each page's title, description, canonical address, one heading and its structured data, the sitemap that
 * lists them and the robots file that lets crawlers in. A page that says one thing to a person and another to a machine, or a sitemap that points at a page that is not there, is worse than none.
 */
const ROOT = resolve(import.meta.dirname, "..");
const SITE = "https://qmax.exchange";
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
// The server's own files (deploy/) are not in the public copy of the repository: the tests that read them are skipped there.
const skipNoDeploy = existsSync(join(ROOT, "deploy/nginx-qmax.conf")) ? false : "deploy/ is not in this copy";

/** The pages in the sitemap and the file each is built from. */
const PAGES: Record<string, string> = {
  [`${SITE}/`]: "web/index.html",
  [`${SITE}/qubic-dex/`]: "web/public/qubic-dex/index.html",
  [`${SITE}/agents/`]: "web/public/agents/index.html",
};

const one = (html: string, re: RegExp) => html.match(re)?.[1];
const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ");

test("the sitemap lists exactly the pages that exist, with a date", () => {
  const xml = read("web/public/sitemap.xml");
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs.sort(), Object.keys(PAGES).sort());
  for (const loc of locs) assert.ok(existsSync(join(ROOT, PAGES[loc])), `${loc} is built from ${PAGES[loc]}`);
  assert.equal([...xml.matchAll(/<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>/g)].length, locs.length, "every page has a lastmod");
});

test("robots.txt lets crawlers in, names the sitemap, and keeps only the API's data endpoints out", () => {
  const robots = read("web/public/robots.txt");
  assert.match(robots, /^User-agent: \*\s*$/m);
  assert.match(robots, /^Allow: \/\s*$/m);
  assert.match(robots, new RegExp(`^Sitemap: ${SITE}/sitemap.xml\\s*$`, "m"));
  assert.match(robots, new RegExp(`^Sitemap: ${SITE}/sitemap-tokens.xml\\s*$`, "m"), "the token pages' sitemap, which the API writes from the live list");
  assert.doesNotMatch(robots, /^Disallow: \/\s*$/m, "the whole site is not disallowed");
  assert.doesNotMatch(robots, /^Disallow: \/qubic-dex|^Disallow: \/agents/m);
});

for (const [url, file] of Object.entries(PAGES)) {
  test(`${file} has a title, description, canonical address and one heading a machine can read`, () => {
    const html = read(file);
    const title = one(html, /<title>([^<]+)<\/title>/)!;
    assert.ok(title && title.length >= 20 && title.length <= 70, `title of ${title?.length} characters: ${title}`);
    const description = one(html, /<meta name="description" content="([^"]+)"/)!;
    assert.ok(description && description.length >= 70 && description.length <= 175, `description of ${description?.length} characters`);
    assert.equal(one(html, /<link rel="canonical" href="([^"]+)"/), url, "the canonical address is the page's own");
    assert.equal(one(html, /<meta property="og:url" content="([^"]+)"/), url);
    assert.doesNotMatch(html, /noindex/i, "nothing tells crawlers to stay away");
    assert.equal((html.match(/<h1[ >]/g) ?? []).length, 1, "one h1");
    for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => JSON.parse(block[1]), "structured data is valid JSON");
  });
}

test("the guide's FAQ markup matches its visible questions and uses facts the rest of the site states", () => {
  const html = read("web/public/qubic-dex/index.html");
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]) as { "@graph": { "@type": string; mainEntity?: { name: string; acceptedAnswer: { text: string } }[] }[] };
  const faq = ld["@graph"].find((n) => n["@type"] === "FAQPage")!.mainEntity!;
  assert.ok(faq.length >= 5);
  const headings = [...html.matchAll(/<h2>([\s\S]*?)<\/h2>/g)].map((m) => text(m[1]).trim());
  for (const q of faq) assert.ok(headings.includes(q.name), `the question "${q.name}" is a heading on the page`);
  const body = text(html);
  for (const q of faq) for (const raw of q.acceptedAnswer.text.match(/\d[\d,.]*%?(?: QU)?/g) ?? []) { const fact = raw.replace(/[.,]+$/, ""); assert.ok(body.includes(fact), `${fact} in the answer to "${q.name}" is on the page too`); }
  // the fees it states are the ones the code uses
  assert.match(body, /0\.3% fee/);
  assert.match(body, /flat 100,000 QU per swap/);
  assert.match(body, /adds no fee of its own/i);
});

test("the home page's own text, for anything that does not run JavaScript, has the page's heading, says what QMax is and points at the guide", () => {
  const html = read("web/index.html");
  // real content in the root element (the app replaces it), not inside <noscript>, which checkers such as Bing's skip: they reported "H1 tag missing" for a heading kept there
  assert.match(html, /<div id="root">[\s\S]*<h1>[^<]*DEX aggregator[^<]*<\/h1>[\s\S]*href="\/qubic-dex\/"[\s\S]*<\/main>\s*<\/div>/);
  assert.doesNotMatch(html, /<noscript>[\s\S]*<h1/, "the heading is not only in <noscript>");
  // and the running app has one too (a screen-reader heading: the terminal itself has no title line)
  assert.match(read("web/App.tsx"), /<h1 className="sr-only">QMax: the Qubic DEX aggregator<\/h1>/);
  assert.match(one(html, /<title>([^<]+)<\/title>/)!, /Qubic DEX aggregator/);
  assert.match(one(html, /<meta name="description" content="([^"]+)"/)!, /Qubic DEX aggregator/);
});

test("nginx answers a missing file with a 404, not the app's page (a 'soft 404')", { skip: skipNoDeploy }, () => {
  const conf = read("deploy/nginx-qmax.conf");
  assert.match(conf, /try_files \$uri \$uri\/ @app;/);
  assert.match(conf, /location @app \{[\s\S]*if \(\$uri ~\* "[^"]*\\\.\[a-z0-9\]\{1,8\}\$"\) \{ return 404; \}[\s\S]*rewrite \^ \/index\.html break;/);
});

test("nginx hands the token pages and their sitemap to the API", { skip: skipNoDeploy }, () => {
  const conf = read("deploy/nginx-qmax.conf");
  assert.match(conf, /location \/token\/ \{[^}]*proxy_pass http:\/\/127\.0\.0\.1:8787;/);
  assert.match(conf, /location = \/token \{\s*return 301 \/token\/;/);
  assert.match(conf, /location = \/sitemap-tokens\.xml \{[^}]*proxy_pass http:\/\/127\.0\.0\.1:8787;/);
  // the script that patches a server already installed adds the same three
  const script = read("deploy/nginx-tokens.sh");
  for (const piece of ["location /token/ {", "location = /token {", "location = /sitemap-tokens.xml {"]) assert.ok(script.includes(piece), piece);
});
