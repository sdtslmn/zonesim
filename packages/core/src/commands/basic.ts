// Everyday shell commands: files, text filters, time and navigation.

import { normalizePath, validFileName } from "../fs.js";
import type { Shell, CommandFn } from "../shell.js";
import { C, UserError, clock } from "../util.js";

function lines(text: string): string[] {
  const l = text.split("\n");
  if (l[l.length - 1] === "") l.pop();
  return l;
}

function numFlag(args: string[], def: number): { n: number; rest: string[] } {
  const rest: string[] = [];
  let n = def;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-n" && args[i + 1]) {
      n = parseInt(args[++i], 10);
    } else if (/^-\d+$/.test(a)) n = parseInt(a.slice(1), 10);
    else if (/^-n\d+$/.test(a)) n = parseInt(a.slice(2), 10);
    else rest.push(a);
  }
  if (!Number.isFinite(n) || n < 0) throw new UserError("invalid number of lines");
  return { n, rest };
}

const input = (shell: Shell, files: string[], stdin: string): string => {
  if (!files.length) return stdin;
  return files
    .map((f) => {
      const t = shell.fs.readFile(f);
      if (t === undefined) throw new UserError(`${f}: No such file`);
      return t;
    })
    .join("");
};

const echo: CommandFn = (args, { io }) => {
  let newline = true;
  if (args[0] === "-n") {
    newline = false;
    args = args.slice(1);
  }
  io.stdout(args.join(" ") + (newline ? "\n" : ""));
  return 0;
};

const cat: CommandFn = (args, { io, shell, stdin }) => {
  io.stdout(input(shell, args, stdin));
  return 0;
};

const ls: CommandFn = (_args, { io, shell }) => {
  const files = shell.fs.list();
  if (files.length) io.stdout(files.join("\n") + "\n");
  return 0;
};

const rm: CommandFn = (args, { io, shell }) => {
  let code = 0;
  for (const f of args.filter((a) => !a.startsWith("-"))) {
    if (!shell.fs.remove(f)) {
      io.stderr(`rm: ${f}: No such file\n`);
      code = 1;
    }
  }
  return code;
};

const touch: CommandFn = (args, { shell }) => {
  for (const f of args) {
    const name = normalizePath(f);
    if (!validFileName(name)) throw new UserError(`${f}: only plain file names in your home folder are supported`);
    if (shell.fs.readFile(name) === undefined) shell.fs.writeFile(name, "");
  }
  return 0;
};

const grep: CommandFn = (args, { io, shell, stdin }) => {
  let invert = false;
  let ignore = false;
  let count = false;
  let pattern: string | undefined;
  const files: string[] = [];
  for (const a of args) {
    if (/^-[ivcE]+$/.test(a)) {
      invert ||= a.includes("v");
      ignore ||= a.includes("i");
      count ||= a.includes("c");
    } else if (pattern === undefined) pattern = a;
    else files.push(a);
  }
  if (pattern === undefined) throw new UserError("usage: grep [-i] [-v] [-c] PATTERN [FILE]");
  let re: RegExp;
  try {
    re = new RegExp(pattern, ignore ? "i" : "");
  } catch {
    throw new UserError(`invalid pattern "${pattern}"`);
  }
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const hits = lines(input(shell, files, stdin)).filter((l) => re.test(plain(l)) !== invert);
  io.stdout(count ? `${hits.length}\n` : hits.map((l) => l + "\n").join(""));
  return hits.length ? 0 : 1;
};

const head: CommandFn = (args, { io, shell, stdin }) => {
  const { n, rest } = numFlag(args, 10);
  io.stdout(lines(input(shell, rest, stdin)).slice(0, n).map((l) => l + "\n").join(""));
  return 0;
};

const tail: CommandFn = (args, { io, shell, stdin }) => {
  const { n, rest } = numFlag(args, 10);
  const l = lines(input(shell, rest, stdin));
  io.stdout(l.slice(Math.max(0, l.length - n)).map((x) => x + "\n").join(""));
  return 0;
};

const wc: CommandFn = (args, { io, shell, stdin }) => {
  const flags = args.filter((a) => a.startsWith("-")).join("");
  const text = input(shell, args.filter((a) => !a.startsWith("-")), stdin);
  const l = lines(text).length;
  const w = text.split(/\s+/).filter(Boolean).length;
  if (flags.includes("l")) io.stdout(`${l}\n`);
  else if (flags.includes("w")) io.stdout(`${w}\n`);
  else io.stdout(`${l} ${w} ${text.length}\n`);
  return 0;
};

const sort: CommandFn = (args, { io, shell, stdin }) => {
  const rev = args.includes("-r");
  const out = lines(input(shell, args.filter((a) => !a.startsWith("-")), stdin)).sort();
  if (rev) out.reverse();
  io.stdout(out.map((l) => l + "\n").join(""));
  return 0;
};

const uniq: CommandFn = (args, { io, shell, stdin }) => {
  const out = lines(input(shell, args, stdin)).filter((l, i, a) => i === 0 || a[i - 1] !== l);
  io.stdout(out.map((l) => l + "\n").join(""));
  return 0;
};

const clear: CommandFn = (_a, { io }) => {
  io.stdout("\x1b[H\x1b[2J");
  return 0;
};

const sleep: CommandFn = async (args, { io }) => {
  const s = parseFloat(args[0] ?? "");
  if (!Number.isFinite(s) || s < 0) throw new UserError("usage: sleep SECONDS");
  await io.sleep(Math.min(s, 120) * 1000);
  return 0;
};

/** Fast-forward the plant. */
const wait: CommandFn = (args, { io, sim }) => {
  const s = parseFloat(args[0] ?? "");
  if (!Number.isFinite(s) || s <= 0 || s > 3600) throw new UserError("usage: wait SECONDS  (fast-forwards the plant, up to 3600)");
  const before = sim.plant.level;
  const alertsBefore = sim.alerts.length;
  sim.settle(s);
  const after = sim.plant.level;
  io.stdout(`Fast-forwarded ${s} s of plant time (now ${clock(sim.t)}). Tank level ${before.toFixed(1)} % → ${after.toFixed(1)} %.\n`);
  const fresh = sim.alerts.length - alertsBefore;
  if (fresh > 0) io.stdout(`${C.yellow(`${fresh} new alert${fresh === 1 ? "" : "s"}.`)} Type ${C.cyan("alerts")} on the console to see them.\n`);
  return 0;
};

const whoami: CommandFn = (_a, { io, host }) => {
  io.stdout(`${host ? host.user || "admin" : "secadmin"}\n`);
  return 0;
};

const hostname: CommandFn = (_a, { io, host }) => {
  io.stdout(`${host ? host.name : "console"}\n`);
  return 0;
};

const pwd: CommandFn = (_a, { io, shell }) => {
  io.stdout(`${shell.fs.home}\n`);
  return 0;
};

const exit: CommandFn = (_a, { io, shell }) => {
  if (shell.stack.length) {
    const left = shell.stack.pop()!;
    const back = shell.host?.name ?? "the console";
    io.stdout(`Connection to ${left} closed. You are back on ${back}.\n`);
    return 0;
  }
  shell.exitRequested = true;
  return 0;
};

export function registerBasic(shell: Shell): void {
  const both = (run: CommandFn, summary?: string) => ({ run, where: "both" as const, summary });
  shell.register("echo", both(echo));
  shell.register("cat", both(cat));
  shell.register("ls", both(ls));
  shell.register("rm", both(rm));
  shell.register("touch", both(touch));
  shell.register("grep", both(grep));
  shell.register("head", both(head));
  shell.register("tail", both(tail));
  shell.register("wc", both(wc));
  shell.register("sort", both(sort));
  shell.register("uniq", both(uniq));
  shell.register("clear", both(clear));
  shell.register("sleep", both(sleep));
  shell.register("wait", both(wait, "fast-forward the plant by some seconds"));
  shell.register("whoami", both(whoami));
  shell.register("hostname", both(hostname));
  shell.register("pwd", both(pwd));
  shell.register("true", both(() => 0));
  shell.register("false", both(() => 1));
  shell.register("exit", both(exit));
}
