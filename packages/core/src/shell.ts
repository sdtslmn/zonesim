// A small shell: quotes, pipes, ; && ||, > and >> redirects, and the Unix
// tools people pipe output into. It tracks where you are: the console (the
// out-of-band management station where you design zones and firewalls) or a
// host you logged in to with ssh, where network tools like modbus and nmap
// send real (simulated) traffic.

import type { FileSystem } from "./fs.js";
import { normalizePath, validFileName } from "./fs.js";
import type { Sim } from "./sim.js";
import type { Host } from "./network.js";
import { C, UserError } from "./util.js";

export interface IO {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Wait. Lab checks map this to plant time. */
  sleep(ms: number): Promise<void>;
}

export interface CmdContext {
  io: IO;
  stdin: string;
  shell: Shell;
  sim: Sim;
  /** The host you are on, or undefined on the console. */
  host?: Host;
}

export type CommandFn = (args: string[], ctx: CmdContext) => Promise<number> | number;

export interface CommandSpec {
  run: CommandFn;
  /** Where the command works. */
  where: "console" | "host" | "both";
  summary?: string;
}

type Token = { type: "word"; value: string } | { type: "op"; value: string };

export function tokenize(line: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let word = "";
  let inWord = false;
  const flush = () => {
    if (inWord) out.push({ type: "word", value: word });
    word = "";
    inWord = false;
  };
  while (i < line.length) {
    const ch = line[i];
    if (ch === "'" || ch === '"') {
      const end = line.indexOf(ch, i + 1);
      if (end === -1) throw new UserError("unterminated quote");
      word += line.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (ch === "\\" && i + 1 < line.length) {
      word += line[i + 1];
      inWord = true;
      i += 2;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      i++;
      continue;
    }
    if (ch === "#" && !inWord) break;
    const two = line.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === ">>") {
      flush();
      out.push({ type: "op", value: two });
      i += 2;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === ">") {
      flush();
      out.push({ type: "op", value: ch });
      i++;
      continue;
    }
    word += ch;
    inWord = true;
    i++;
  }
  flush();
  return out;
}

interface SimpleCommand {
  words: string[];
  redirect?: { file: string; append: boolean };
}

interface Pipeline {
  commands: SimpleCommand[];
  /** How this pipeline joins the previous one. */
  join: ";" | "&&" | "||";
}

function parse(tokens: Token[]): Pipeline[] {
  const lists: Pipeline[] = [];
  let pipe: SimpleCommand[] = [];
  let cmd: SimpleCommand = { words: [] };
  let join: Pipeline["join"] = ";";
  const endCommand = () => {
    if (cmd.words.length === 0) throw new UserError("syntax error near an operator");
    pipe.push(cmd);
    cmd = { words: [] };
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "word") {
      cmd.words.push(t.value);
      continue;
    }
    if (t.value === ">" || t.value === ">>") {
      const f = tokens[i + 1];
      if (!f || f.type !== "word") throw new UserError("syntax error: missing file name after >");
      cmd.redirect = { file: f.value, append: t.value === ">>" };
      i++;
      continue;
    }
    if (t.value === "|") {
      endCommand();
      continue;
    }
    // ; && ||
    if (cmd.words.length) endCommand();
    if (pipe.length) lists.push({ commands: pipe, join });
    else if (t.value !== ";") throw new UserError(`syntax error near "${t.value}"`);
    pipe = [];
    join = t.value as Pipeline["join"];
  }
  if (cmd.words.length) endCommand();
  else if (pipe.length) throw new UserError("syntax error: a pipe needs a command after it");
  if (pipe.length) lists.push({ commands: pipe, join });
  return lists;
}

/** Re-quote words so a command line can be rebuilt (for ssh host <command>). */
export function quote(words: string[]): string {
  return words.map((w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(" ");
}

export class Shell {
  /** Hosts you are logged in to, innermost last. Empty means the console. */
  readonly stack: string[] = [];
  readonly commands = new Map<string, CommandSpec>();
  /** Set when exit is typed on the console. */
  exitRequested = false;
  lastCode = 0;

  constructor(
    readonly sim: Sim,
    readonly fs: FileSystem,
  ) {}

  register(name: string, spec: CommandSpec): void {
    this.commands.set(name, spec);
  }

  get host(): Host | undefined {
    const name = this.stack[this.stack.length - 1];
    return name ? this.sim.net.host(name) : undefined;
  }

  prompt(): string {
    const h = this.host;
    if (!h) return `${C.green("console")}:${C.cyan("~")}$ `;
    const user = h.user || "admin";
    return `${C.yellow(`${user}@${h.name}`)}:${C.cyan("~")}$ `;
  }

  /** Command names available where you are, for tab completion. */
  available(): string[] {
    const here = this.host ? "host" : "console";
    return [...this.commands.entries()].filter(([, s]) => s.where === "both" || s.where === here).map(([n]) => n).sort();
  }

  /** Run one or more lines. Returns the exit code of the last command. */
  async exec(input: string, io: IO): Promise<number> {
    let code = 0;
    for (const raw of input.replace(/\r/g, "").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      try {
        code = await this.runLine(line, io);
      } catch (e) {
        if (e instanceof UserError) {
          io.stderr(`${e.message}\n`);
          code = 1;
        } else throw e;
      }
      this.lastCode = code;
      if (this.exitRequested) break;
    }
    return code;
  }

  private async runLine(line: string, io: IO): Promise<number> {
    const lists = parse(tokenize(line));
    let code = 0;
    for (const p of lists) {
      if (p.join === "&&" && code !== 0) continue;
      if (p.join === "||" && code === 0) continue;
      code = await this.runPipeline(p.commands, io);
      if (this.exitRequested) break;
    }
    return code;
  }

  private async runPipeline(cmds: SimpleCommand[], io: IO): Promise<number> {
    let stdin = "";
    let code = 0;
    for (let i = 0; i < cmds.length; i++) {
      const c = cmds[i];
      const last = i === cmds.length - 1;
      let buf = "";
      const capture = !last || !!c.redirect;
      const cio: IO = { stdout: capture ? (t) => (buf += t) : io.stdout, stderr: io.stderr, sleep: io.sleep };
      try {
        code = await this.runCommand(c.words, cio, stdin);
      } catch (e) {
        if (!(e instanceof UserError)) throw e;
        const name = c.words[0];
        io.stderr(`${name}: ${e.message}\n`);
        code = 1;
      }
      if (c.redirect) {
        const file = normalizePath(c.redirect.file);
        if (!validFileName(file)) {
          io.stderr(`${c.redirect.file}: only plain file names in your home folder are supported\n`);
          return 1;
        }
        const plain = buf.replace(/\x1b\[[0-9;]*m/g, "");
        this.fs.writeFile(file, c.redirect.append ? (this.fs.readFile(file) ?? "") + plain : plain);
        buf = "";
      }
      stdin = buf;
    }
    return code;
  }

  private async runCommand(words: string[], io: IO, stdin: string): Promise<number> {
    const [name, ...args] = words;
    const spec = this.commands.get(name);
    const here = this.host ? "host" : "console";
    if (!spec) {
      io.stderr(`${name}: command not found. Type ${C.cyan("help")} to see what you can run here.\n`);
      return 127;
    }
    if (spec.where !== "both" && spec.where !== here) {
      if (here === "host") io.stderr(`${name}: this is a console command. Type ${C.cyan("exit")} to go back to the console.\n`);
      else io.stderr(`${name}: run this on a host, for example ${C.cyan(`ssh hmi-01`)}, then ${C.cyan(name)}. Or in one go: ${C.cyan(`ssh hmi-01 ${name} ...`)}\n`);
      return 1;
    }
    this.sim.advance();
    const code = await spec.run(args, { io, stdin, shell: this, sim: this.sim, host: this.host });
    this.sim.advance();
    return code;
  }

  /** Run a command line as if logged in to a host (ssh host <command>). */
  async onHost(host: string, line: string, io: IO): Promise<number> {
    this.stack.push(host);
    try {
      return await this.exec(line, io);
    } finally {
      // exit inside the one-shot command only leaves that host.
      this.exitRequested = false;
      const i = this.stack.lastIndexOf(host);
      if (i >= 0) this.stack.splice(i);
    }
  }
}
