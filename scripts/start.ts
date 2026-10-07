// Runs the API (port 8787) and the web app (port 5173) together; Ctrl+C stops both.
//
//   npm start            the website on this computer only (127.0.0.1)
//   npm run start:lan    also reachable from other devices on your network (a phone on the same Wi-Fi): http://<this computer's address>:5173
//
// In both cases the API stays on 127.0.0.1: the website's server passes /api on to it, so the phone only ever talks to the website.
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";

const lan = process.env.LAN === "1";

const run = (cmd: string, args: string[]) => spawn(cmd, args, { stdio: "inherit" });
// .env (if there is one) is read by the API too: API_KEY, prices, and the rest of .env.example
const api = run("node", ["--experimental-strip-types", "--no-warnings", "--env-file-if-exists=.env", "src/server.ts"]);
const web = run("npx", lan ? ["vite", "--host", "0.0.0.0", "--port", "5173", "--strictPort"] : ["vite", "--host", "127.0.0.1", "--open"]);
if (lan) {
  const mine = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i!.address);
  setTimeout(() => console.log(`\nOn your phone (same Wi-Fi), open:\n${mine.map((a) => `  http://${a}:5173`).join("\n")}\nOnly the website is shared; the API stays on this computer. Ctrl+C stops it.\n`), 2500);
}
const stop = () => {
  api.kill();
  web.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
api.on("exit", stop);
web.on("exit", stop);
