// The training app shared by the CLI and the browser: labs, the sandbox,
// progress, help, and the lab commands (labs, lab, task, check, hint ...).

import { LabSession, type CheckResult } from "./labs/session.js";
import { sortLabs, findLab, type Lab } from "./labs/schema.js";
import { resolveLab } from "./labs/resolve.js";
import { validateLabsOnSite, type LabFit } from "./labs/validate.js";
import { siteCompatible, type Site } from "./site.js";
import { builtinSite } from "./sites/index.js";
import { MemoryFS } from "./fs.js";
import type { IO, CommandFn, Shell } from "./shell.js";
import { C, termMd, wrapText, reflow } from "./util.js";
import { VERSION } from "./version.js";

export interface TrainerOptions {
  labs: Lab[];
  /** Milliseconds, like Date.now. */
  clock?: () => number;
  /** Write text to the terminal. Lines end with \n. */
  print: (text: string) => void;
  progress?: { load(): string[]; save(ids: string[]): void };
  /** Called when the lab, the view or the check results change. */
  onChange?: () => void;
  /** Real waiting for sleep. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Terminal width in columns, for wrapping lab text. */
  columns?: () => number;
  /** The site to use. Defaults to the built-in Riverside plant. */
  site?: Site;
}

const LEVEL_TAG: Record<string, string> = { beginner: "B", intermediate: "I", advanced: "A", scenario: "S" };

export const CONSOLE_HELP = `${C.bold("ZoneSim console")}  (out-of-band management station; nothing here is real)

${C.bold("Look around")}
  hosts                          hosts, IPs, Purdue levels, zones and services
  plant                          process values, alarms and the plant's data flows
  hmi                            what the operator sees on the HMI
  ssh HOST [COMMAND]             log in to a host; its commands then send traffic from it
  devices, ssh DEVICE            the firewall and switches, in their own command line
  takeover [start|end]           lose the main control centre, or bring it back (metro)
${C.bold("Design zones and conduits")}
  zone list|create|add|show|set|delete
  conduit list|create|show|delete
  fw list|allow|deny|delete|log  firewall rules on conduits, incl. Modbus function codes
  test SRC DST SERVICE [fc N]    would this traffic get through? (nothing is sent)
  host config HOST mfa=on        host settings
${C.bold("Monitor and investigate")}
  flows                          who talks to whom, and what got blocked
  alerts [show ID | ack ID]      alerts from the IDS sensor and the process
  report                         design review: data flows and security checks
  wait SECONDS                   fast-forward the plant
${C.bold("Labs")}
  labs, lab N, task, check, hint, solution, reset, next, sandbox

Shell: pipes (| grep, head, tail, wc, sort), ; && ||, > and >> into files, echo, cat, ls, rm.
Every command has --help, for example: fw --help. The Help tab in the browser explains everything.
`;

export function hostHelp(name: string, ip: string, devices: string[] = []): string {
  return `${C.bold(`You are on ${name}`)} (${ip}). Commands here send traffic from this host.

  modbus read|write|info HOST ...  talk Modbus to ${devices.length ? devices.join(" or ") : "a controller"}  (modbus --help)
  modbus map HOST                  the register map from the vendor manual
  nmap TARGET                      find open ports; TARGET can be a network, e.g. ${ip.split(".").slice(0, 3).join(".")}.0/24
  ping HOST, curl URL, ip addr
  rdp HOST, ssh HOST               remote login to another host, across the network
  exit                             leave this host

Lab commands (task, check, hint ...) work here too.
`;
}

export class Trainer {
  readonly labs: Lab[];
  readonly fs = new MemoryFS();
  session!: LabSession;
  /** The current lab as written, and filled in for the site it runs on. */
  lab?: Lab;
  resolved?: Lab;
  done: Set<string>;
  lastResults?: CheckResult[];
  /** The site chosen by the learner. Labs that do not fit it run on their own site. */
  site: Site;
  /** Which labs work on the chosen site (filled in by checkLabs). */
  fits = new Map<string, LabFit>();
  /** Why the current lab is not running on the chosen site, if it is not. */
  siteNote?: string;
  private opts: TrainerOptions;

  constructor(opts: TrainerOptions) {
    this.opts = opts;
    this.labs = sortLabs(opts.labs);
    this.done = new Set(opts.progress?.load() ?? []);
    this.site = opts.site ?? builtinSite();
  }

  /** Switch site. Call checkLabs() afterwards to learn which labs fit it. */
  setSite(site: Site): void {
    this.site = site;
    this.fits.clear();
  }

  /** Run the solution of every lab written for the chosen site's plant against it. */
  async checkLabs(): Promise<LabFit[]> {
    const fits = await validateLabsOnSite(this.labs.filter((l) => siteCompatible(this.site, l.site)), this.site);
    this.fits = new Map(fits.map((f) => [f.lab.id, f]));
    this.changed();
    return fits;
  }

  /** The site a lab will run on, and the lab filled in for it. */
  siteFor(lab: Lab): { site: Site; resolved: Lab; note?: string } {
    const fit = this.fits.get(lab.id);
    if (siteCompatible(this.site, lab.site) && fit?.ok !== false) {
      const r = resolveLab(lab, this.site);
      if (r.lab) return { site: this.site, resolved: r.lab };
    }
    const own = builtinSite(lab.site);
    const r = resolveLab(lab, own);
    if (!r.lab) throw new Error(`lab ${lab.id} does not resolve on its own site: ${r.error}`);
    if (!siteCompatible(this.site, lab.site)) return { site: own, resolved: r.lab };
    const why = fit?.problems[0] ?? (siteCompatible(this.site, lab.site) ? resolveLab(lab, this.site).error : `${this.site.name} does not extend ${own.name}`);
    return { site: own, resolved: r.lab, note: `This lab runs on ${own.name}. It does not fit ${this.site.name}${why ? `: ${why}` : ""}.` };
  }

  get sim() {
    return this.session.sim;
  }

  get shell(): Shell {
    return this.session.shell;
  }

  /** Width to wrap lab text at. */
  private get width(): number {
    const cols = this.opts.columns?.() ?? 80;
    return Math.max(40, Math.min(88, cols - 2));
  }

  private print(text: string): void {
    this.opts.print(text);
  }

  private changed(): void {
    this.opts.onChange?.();
  }

  io(): IO {
    return {
      stdout: (t) => this.print(t),
      stderr: (t) => this.print(C.red(t.replace(/\n$/, "")) + (t.endsWith("\n") ? "\n" : "")),
      sleep: this.opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
  }

  // ---------------------------------------------------------------- sessions

  async startSandbox(announce = true): Promise<void> {
    this.fs.clear();
    this.lab = undefined;
    this.resolved = undefined;
    this.siteNote = undefined;
    this.lastResults = undefined;
    this.session = new LabSession(undefined, this.fs, { site: this.site, clock: this.opts.clock });
    this.registerLabCommands(this.session.shell);
    await this.session.setup();
    if (announce) this.print(`${C.bold("Sandbox")}: ${this.site.name} as found. Type ${C.cyan("help")} for commands, ${C.cyan("labs")} for guided labs.\n`);
    this.changed();
  }

  async startLab(lab: Lab, announce = true): Promise<void> {
    this.fs.clear();
    const { site, resolved, note } = this.siteFor(lab);
    this.lab = lab;
    this.resolved = resolved;
    this.siteNote = note;
    this.lastResults = undefined;
    this.session = new LabSession(resolved, this.fs, { site, clock: this.opts.clock });
    this.registerLabCommands(this.session.shell);
    const errors = await this.session.setup();
    for (const e of errors) this.print(C.yellow(`(setup) ${e}\n`));
    if (announce) {
      if (note) this.print(C.yellow(note) + "\n");
      this.print(this.labIntro(resolved));
    }
    this.changed();
  }

  async run(line: string): Promise<number> {
    const code = await this.shell.exec(line, this.io());
    this.changed();
    return code;
  }

  prompt(): string {
    const tag = this.lab ? C.yellow(`[${this.lab.id.split("-")[0]}] `) : "";
    return tag + this.shell.prompt();
  }

  complete(line: string): string[] {
    const words = line.split(/\s+/);
    const last = words[words.length - 1] ?? "";
    let candidates: string[] = [];
    const net = this.sim.net;
    const hostNames = net.hosts.map((h) => h.name);
    const session = this.shell.session;
    if (session) candidates = words.length === 1 ? session.words() : session.complete(words);
    else if (words.length === 1) candidates = this.shell.available();
    else {
      const cmd = words[0];
      const sub = words[1];
      if (cmd === "lab" && words.length === 2) candidates = this.labs.map((l) => l.id);
      else if (cmd === "zone" && words.length === 2) candidates = ["list", "create", "add", "show", "set", "delete"];
      else if (cmd === "conduit" && words.length === 2) candidates = ["list", "create", "show", "delete"];
      else if (cmd === "fw" && words.length === 2) candidates = ["list", "allow", "deny", "delete", "log"];
      else if (cmd === "fw" && words.length === 3 && sub !== "log") candidates = net.conduits.map((c) => c.name);
      else if (cmd === "fw" && words.length > 3) candidates = ["from", "to", "any", "fc", "at", ...hostNames, ...net.zones.map((z) => z.name), "modbus", "http", "https", "rdp", "ssh", "icmp"];
      else if (cmd === "conduit" && words.length >= 3) candidates = [...net.conduits.map((c) => c.name), ...net.zones.map((z) => z.name)];
      else if (cmd === "zone" && words.length === 3) candidates = net.zones.map((z) => z.name);
      else if (cmd === "zone" && words.length > 3) candidates = hostNames;
      else if (cmd === "modbus" && words.length === 2) candidates = ["read", "write", "info", "map"];
      else if (cmd === "modbus" && words.length === 3) candidates = [...this.sim.devices.keys()];
      else if (cmd === "modbus" && words.length === 4) candidates = sub === "write" ? ["coil", "hr"] : ["coil", "di", "ir", "hr"];
      else if (cmd === "alerts" && words.length === 2) candidates = ["show", "ack", "--all"];
      else if (cmd === "alerts" && words.length === 3) candidates = [...this.sim.alerts.map((a) => a.id), "all"];
      else if (cmd === "ssh" && words.length === 2 && !this.shell.host) candidates = [...this.sim.infra.devices.map((d) => d.name), ...hostNames];
      else if (["ssh", "rdp", "ping", "nmap", "test", "host", "flows"].includes(cmd)) candidates = cmd === "host" && words.length === 2 ? ["show", "config"] : hostNames;
      else candidates = hostNames;
    }
    return candidates.filter((c) => c.startsWith(last));
  }

  // ---------------------------------------------------------------- text

  labCode(lab: Lab): string {
    return lab.id.split("-")[0].toUpperCase();
  }

  labList(): string {
    const out: string[] = [C.bold("ZoneSim labs") + C.gray(`  (${this.done.size}/${this.labs.length} done)`)];
    let level = "";
    let site = "";
    this.labs.forEach((l, i) => {
      if (l.site !== site) {
        site = l.site;
        level = "";
        out.push("", C.bold(C.cyan(builtinSite(site).name)));
      }
      if (l.level !== level) {
        level = l.level;
        out.push(C.bold(`  ${level[0].toUpperCase() + level.slice(1)}`));
      }
      const mark = this.done.has(l.id) ? C.green("✔") : " ";
      out.push(`  ${mark} ${String(i + 1).padStart(2)}  ${this.labCode(l).padEnd(4)} ${l.title}  ${C.gray(`${l.minutes} min · ${l.topic}`)}`);
    });
    out.push("", `Start one with ${C.cyan("lab 1")} or ${C.cyan("lab b01")}.`);
    return out.join("\n") + "\n";
  }

  labIntro(lab: Lab): string {
    const out = [
      "",
      `${C.bold(`${this.labCode(lab)}  ${lab.title}`)}  ${C.gray(`${lab.level}, about ${lab.minutes} min`)}`,
      "",
      wrapText(termMd(reflow(lab.intro)), this.width),
      "",
      C.bold("Tasks"),
      ...lab.tasks.map((t, i) => wrapText(`${i + 1}. ${termMd(t)}`, this.width, "  ")),
      "",
      C.gray(wrapText("Type check when you are done, hint if you are stuck.", this.width)),
      "",
    ];
    return out.join("\n") + "\n";
  }

  // ---------------------------------------------------------------- lab actions

  /** The next lab on the same plant, or the first unfinished one when no lab is open. */
  nextLab(): Lab | undefined {
    if (!this.lab) return this.labs.find((l) => !this.done.has(l.id)) ?? this.labs[0];
    const i = this.labs.indexOf(this.lab);
    const next = this.labs[i + 1];
    return next && next.site === this.lab.site ? next : undefined;
  }

  /** Labs written for the same plant as this one. */
  plantLabs(lab: Lab): Lab[] {
    return this.labs.filter((l) => l.site === lab.site);
  }

  async check(): Promise<CheckResult[]> {
    const results = await this.session.check();
    this.lastResults = results;
    const io = this.io();
    for (const r of results) io.stdout(r.passed ? `${C.green("✔")} ${r.name}\n` : `${C.red("✘")} ${r.name}${r.detail ? C.gray(`  (${r.detail})`) : ""}\n`);
    const passed = results.filter((r) => r.passed).length;
    io.stdout("\n");
    if (passed === results.length && this.lab) {
      io.stdout(C.green(C.bold("All checks passed. Lab complete!")) + "\n");
      if (this.resolved?.learned) io.stdout("\n" + wrapText(termMd(reflow(this.resolved.learned)), this.width) + "\n");
      if (this.lab.refs.length) io.stdout(C.gray(`\nRelated: ${this.lab.refs.join("; ")}\n`));
      this.done.add(this.lab.id);
      this.opts.progress?.save([...this.done]);
      const next = this.nextLab();
      io.stdout(next ? `\nType ${C.cyan("next")} to start: ${next.title}\n` : "\nThat was the last lab for this plant. Well done. Type labs to pick another plant.\n");
    } else {
      io.stdout(`${passed} of ${results.length} checks passed. Type ${C.cyan("hint")} if you are stuck.\n`);
    }
    this.changed();
    return results;
  }

  private registerLabCommands(shell: Shell): void {
    const both = (run: CommandFn) => ({ run, where: "both" as const });
    const needLab = (io: IO): boolean => {
      if (this.lab) return true;
      io.stderr(`You are in the sandbox. Start a lab first, e.g. ${C.cyan("lab 1")}. Type ${C.cyan("labs")} to see them all.\n`);
      return false;
    };
    shell.register("help", both((_a, { io, host }) => {
      io.stdout(host ? hostHelp(host.name, host.ip, [...this.sim.devices.keys()]) : CONSOLE_HELP);
      return 0;
    }));
    shell.register("labs", both((_a, { io }) => {
      io.stdout(this.labList());
      return 0;
    }));
    shell.register("lab", both(async (args, { io }) => {
      if (!args[0]) {
        if (this.resolved) io.stdout(this.labIntro(this.resolved));
        else io.stdout(this.labList());
        return 0;
      }
      const lab = findLab(this.labs, args[0]);
      if (!lab) {
        io.stderr(`No lab matches "${args[0]}". Type labs to see them.\n`);
        return 1;
      }
      await this.startLab(lab);
      return 0;
    }));
    const tasks: CommandFn = (_a, { io }) => {
      if (!needLab(io)) return 1;
      io.stdout(this.resolved!.tasks.map((t, i) => wrapText(`${i + 1}. ${termMd(t)}`, this.width, "  ")).join("\n") + "\n");
      return 0;
    };
    shell.register("task", both(tasks));
    shell.register("tasks", both(tasks));
    shell.register("check", both(async (_a, { io }) => {
      if (!needLab(io)) return 1;
      const r = await this.check();
      return r.every((x) => x.passed) ? 0 : 1;
    }));
    shell.register("hint", both((_a, { io }) => {
      if (!needLab(io)) return 1;
      const h = this.session.nextHint();
      io.stdout(h ? `${C.yellow(`Hint ${h.index}/${h.total}:`)} ${wrapText(termMd(h.text), this.width)}\n` : "This lab has no hints.\n");
      return 0;
    }));
    shell.register("solution", both((_a, { io }) => {
      if (!needLab(io)) return 1;
      io.stdout(C.yellow("One way to solve it (try it yourself first, you learn more that way):") + "\n");
      for (const s of this.resolved!.solution) io.stdout(`  ${C.cyan(s)}\n`);
      return 0;
    }));
    shell.register("reset", both(async (_a, { io }) => {
      if (this.lab) {
        await this.startLab(this.lab, false);
        io.stdout("Lab reset: the plant, the network and your files are back to the start.\n");
      } else {
        await this.startSandbox(false);
        io.stdout("Sandbox reset: the plant as found, with a flat network.\n");
      }
      return 0;
    }));
    shell.register("next", both(async (_a, { io }) => {
      const n = this.nextLab();
      if (!n) {
        io.stderr("There is no next lab.\n");
        return 1;
      }
      await this.startLab(n);
      return 0;
    }));
    shell.register("sandbox", both(async () => {
      await this.startSandbox();
      return 0;
    }));
    shell.register("version", both((_a, { io }) => {
      io.stdout(`ZoneSim ${VERSION}\n`);
      return 0;
    }));
  }
}

export { LEVEL_TAG };
