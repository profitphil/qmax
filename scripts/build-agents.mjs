// Builds what the site hosts under /agents/ for AI agents and their developers: the MCP server as one file, the SDK as an npm package and as one file, and the
// checksums of all three. It writes into web/public/agents/, which `vite build` copies into the site; deploy/deploy.sh runs it first.
//
//   npm run agents:build
//
// The MCP file is built to talk to https://qmax.exchange/api when QMAX_API_URL is not given (AGENTS_API_URL changes that for another site).
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "web/public/agents");
const api = process.env.AGENTS_API_URL ?? "https://qmax.exchange/api";
const FILES = ["qmax-mcp.mjs", "qmax-sdk.js", "qmax-sdk.tgz"];

mkdirSync(out, { recursive: true });
for (const f of [...FILES, "SHA256SUMS"]) rmSync(join(out, f), { force: true });

// The MCP server: one file, run with Node. It reads no file and no secret of ours; QMAX_API_KEY and QMAX_AGENT_SEED come from the user's own environment.
await build({
  entryPoints: [join(root, "mcp/server.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: join(out, "qmax-mcp.mjs"),
  logLevel: "warning",
  banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
  define: { QMAX_DEFAULT_API: JSON.stringify(api) },
});

// The SDK: built the usual way, then packed as the npm package it is (so `npm i <url>` gives types too), and as the one neutral file for any runtime.
execFileSync("npm", ["run", "sdk:build"], { cwd: root, stdio: "inherit" });
// The SDK needs the shape of a Max plan, not the planner: the declaration file keeps the types and drops the tuning knobs and `planMax` (which would otherwise describe how Max decides).
const maxTypes = join(root, "sdk/dist/types/src/maxplan.d.ts");
const declared = readFileSync(maxTypes, "utf8");
const cut = declared.indexOf("/** Tuning, in one place. */");
if (cut >= 0) writeFileSync(maxTypes, declared.slice(0, cut).trimEnd() + "\n");
else if (declared.includes("MAX_TUNING")) throw new Error("maxplan.d.ts changed: update the cut in scripts/build-agents.mjs so the planner's tuning is not published");
// (no marker and no MAX_TUNING: a copy of the project where the planner is only a stand-in, so there is nothing to cut)
const tmp = mkdtempSync(join(tmpdir(), "qmax-sdk-"));
execFileSync("npm", ["pack", "./sdk", "--pack-destination", tmp, "--silent"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
const packed = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
if (!packed) throw new Error("npm pack made no tarball");
copyFileSync(join(tmp, packed), join(out, "qmax-sdk.tgz")); // a copy, not a rename: the temp folder can be on another disk
rmSync(tmp, { recursive: true, force: true });
copyFileSync(join(root, "sdk/dist/index.js"), join(out, "qmax-sdk.js"));

// What a person can check a download against.
const sums = FILES.map((f) => `${createHash("sha256").update(readFileSync(join(out, f))).digest("hex")}  ${f}`);
writeFileSync(join(out, "SHA256SUMS"), sums.join("\n") + "\n");
console.log(`agents: ${FILES.length} files in web/public/agents (MCP default API ${api})\n${sums.join("\n")}`);
