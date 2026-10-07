/**
 * Asks for a secret (a seed) at the terminal without showing it. A seed typed after `NAME=` on the command line is kept by the shell's history
 * file and shown by `ps` to other users of the machine; typed here it is in neither, and it is only ever in this process's memory.
 * Returns null when there is no terminal to ask on (the caller then says how else to provide it) or the person pressed Ctrl-C.
 */
export interface SecretInput {
  isTTY?: boolean;
  setRawMode?(on: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  setEncoding(e: BufferEncoding): unknown;
  on(event: "data", cb: (chunk: string) => void): unknown;
  off(event: "data", cb: (chunk: string) => void): unknown;
}

export async function readSecret(question: string, input: SecretInput = process.stdin as unknown as SecretInput, output: { write(s: string): unknown } = process.stderr): Promise<string | null> {
  if (!input.isTTY || !input.setRawMode) return null;
  output.write(question);
  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();
  return new Promise((resolve) => {
    let typed = "";
    const finish = (value: string | null) => {
      input.off("data", onData);
      input.setRawMode!(false);
      input.pause();
      output.write("\n");
      resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish(typed.trim());
        if (ch === "\u0003" || ch === "\u0004") return finish(null); // Ctrl-C, Ctrl-D
        if (ch === "\u007f" || ch === "\b") typed = typed.slice(0, -1);
        else if (ch >= " ") typed += ch;
      }
    };
    input.on("data", onData);
  });
}
