// Starts the API (with reload) and the Vite UI together; Ctrl+C stops both.
import { spawn, type ChildProcess } from "node:child_process";

const bin = (name: string) => new URL(`../node_modules/.bin/${name}`, import.meta.url).pathname;
const procs: ChildProcess[] = [];
const run = (label: string, color: number, cmd: string, args: string[]) => {
  const p = spawn(cmd, args, { stdio: ["inherit", "pipe", "pipe"], env: process.env });
  const prefix = `\x1b[${color}m[${label}]\x1b[0m `;
  const pipe = (s: NodeJS.ReadableStream, out: NodeJS.WriteStream) =>
    s.on("data", (d: Buffer) => out.write(d.toString().replace(/^(?=.)/gm, prefix)));
  pipe(p.stdout!, process.stdout);
  pipe(p.stderr!, process.stderr);
  p.on("exit", (code) => {
    console.log(`${prefix}exited (${code ?? "signal"})`);
    shutdown(code ?? 0);
  });
  procs.push(p);
};
let stopping = false;
function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) if (p.exitCode === null) p.kill("SIGTERM");
  process.exitCode = code;
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
run("api", 35, bin("tsx"), ["watch", "server/index.ts"]);
run("ui", 36, bin("vite"), []);
