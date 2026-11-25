// Cisco IOS command line for an industrial Ethernet switch: VLANs, access
// ports, shutdown, and the show commands.

import type { Sim } from "../sim.js";
import type { SwitchDevice, SwitchPort } from "../infra.js";
import { normalizePort } from "../site.js";
import { UserError } from "../util.js";
import { deviceTokens, matchPattern, firstWords, nextWords, parseVlan, type DeviceSession, type Pattern } from "./session.js";

type Mode = "user" | "priv" | "config" | "vlan" | "interface";
const ANY_EXEC: Mode[] = ["user", "priv"];
const CONFIG: Mode[] = ["config", "vlan", "interface"];

export class IosSession implements DeviceSession {
  done = false;
  private mode: Mode = "user";
  private port?: SwitchPort;
  private vlan?: number;
  private out: (t: string) => void = () => {};
  private readonly patterns: Pattern<Mode>[];

  constructor(
    private readonly sim: Sim,
    readonly device: SwitchDevice,
  ) {
    const infra = () => this.sim.infra;
    const sw = device;
    const shows: [string[], () => void, string?][] = [
      [["show", "vlan", "brief"], () => this.showVlanBrief(), "show vlan brief"],
      [["show", "interfaces", "status"], () => this.showStatus(), "show interfaces status"],
      [["show", "running-config"], () => this.showRunning(), "show running-config"],
      [["show", "version"], () => this.showVersion(), "show version"],
    ];
    this.patterns = [
      { modes: ["user"], words: ["enable"], run: () => (this.mode = "priv"), help: "enable" },
      { modes: ["priv"], words: ["disable"], run: () => (this.mode = "user") },
      { modes: ["priv"], words: ["configure", "terminal"], run: () => {
        this.mode = "config";
        this.out("Enter configuration commands, one per line.  End with CNTL/Z.\n");
      }, help: "configure terminal" },
      { modes: ["priv"], words: ["write", "memory"], run: () => this.save(), help: "write memory" },
      { modes: ["priv"], words: ["write"], run: () => this.save() },
      { modes: ["priv"], words: ["copy", "running-config", "startup-config"], run: () => this.save() },
      { modes: CONFIG, words: ["vlan", "<id>"], run: ([v]) => {
        const id = parseVlan(v);
        infra().createVlan(id);
        sw.unsaved = true;
        this.vlan = id;
        this.mode = "vlan";
      }, help: "vlan 30                      create VLAN 30 and configure it" },
      { modes: CONFIG, words: ["no", "vlan", "<id>"], run: ([v]) => {
        infra().deleteVlan(parseVlan(v));
        sw.unsaved = true;
      }, help: "no vlan 30" },
      { modes: ["vlan"], words: ["name", "<name...>"], run: ([n]) => {
        infra().nameVlan(this.vlan!, n);
        sw.unsaved = true;
      }, help: "name control                 (in vlan mode) the name becomes the zone name" },
      { modes: CONFIG, words: ["interface", "<port...>"], run: ([p]) => this.enterPort(p), help: "interface Gi1/3" },
      { modes: ["interface"], words: ["switchport", "mode", "access"], run: () => void 0, help: "switchport mode access" },
      { modes: ["interface"], words: ["switchport", "access", "vlan", "<id>"], run: ([v]) => {
        const id = parseVlan(v);
        if (!this.sim.net.zoneByVlan(id)) {
          infra().createVlan(id);
          this.out(`% Access VLAN does not exist. Creating vlan ${id}\n`);
        }
        infra().setPvid(sw, this.port!, id, { access: true });
      }, help: "switchport access vlan 30    put the port in VLAN 30" },
      { modes: ["interface"], words: ["shutdown"], run: () => infra().setShutdown(sw, this.port!, true), help: "shutdown / no shutdown" },
      { modes: ["interface"], words: ["no", "shutdown"], run: () => infra().setShutdown(sw, this.port!, false) },
      { modes: ["interface"], words: ["description", "<text...>"], run: ([t]) => {
        this.port!.name = t;
        sw.unsaved = true;
      } },
      ...shows.map(([w, run, help]): Pattern<Mode> => ({ modes: ANY_EXEC, words: w, run, help })),
      ...shows.map(([w, run]): Pattern<Mode> => ({ modes: CONFIG, words: ["do", ...w], run })),
      { modes: ["user", "priv", ...CONFIG], words: ["help"], run: () => this.help() },
      { modes: ["user", "priv", ...CONFIG], words: ["?"], run: () => this.help() },
      { modes: CONFIG, words: ["end"], run: () => (this.mode = "priv") },
      { modes: ["user", "priv", ...CONFIG], words: ["exit"], run: () => this.exit() },
      { modes: ANY_EXEC, words: ["logout"], run: () => (this.done = true) },
      { modes: ANY_EXEC, words: ["quit"], run: () => (this.done = true) },
    ];
  }

  prompt(): string {
    const h = this.device.hostname;
    switch (this.mode) {
      case "user":
        return `${h}>`;
      case "priv":
        return `${h}#`;
      case "config":
        return `${h}(config)#`;
      case "vlan":
        return `${h}(config-vlan)#`;
      case "interface":
        return `${h}(config-if)#`;
    }
  }

  words(): string[] {
    return firstWords(this.patterns, this.mode);
  }

  complete(words: string[]): string[] {
    return nextWords(this.patterns, this.mode, words.slice(0, -1), (holder) => {
      if (holder === "<port>" || holder === "<port...>") return this.device.ports.map((p) => p.id);
      if (holder === "<id>") return this.sim.infra.vlans().map((z) => String(z.vlan));
      return [];
    });
  }

  run(line: string, out: (t: string) => void): void {
    this.out = out;
    const tokens = deviceTokens(line);
    if (!tokens.length) return;
    const m = matchPattern(this.patterns, this.mode, tokens);
    if ("error" in m) {
      if (m.error.startsWith("ambiguous")) out(`% Ambiguous command:  "${tokens.join(" ")}"\n`);
      else if (m.error === "incomplete") out("% Incomplete command.\n");
      else {
        const at = parseInt(m.error.split(":")[1] ?? "0", 10);
        const col = this.prompt().length + tokens.slice(0, at).join(" ").length + (at ? 1 : 0);
        out(`${" ".repeat(col)}^\n% Invalid input detected at '^' marker.\n`);
      }
      return;
    }
    try {
      m.pattern.run(m.args);
    } catch (e) {
      if (e instanceof UserError) out(`% ${e.message}\n`);
      else throw e;
    }
  }

  private exit(): void {
    if (this.mode === "interface" || this.mode === "vlan") this.mode = "config";
    else if (this.mode === "config") this.mode = "priv";
    else this.done = true;
  }

  private enterPort(text: string): void {
    const id = normalizePort("cisco", text.replace(/\s+/g, ""));
    const port = id ? this.device.ports.find((p) => p.id === id) : undefined;
    if (!port) throw new UserError(`Invalid interface ${text}. Ports: ${this.device.ports.map((p) => p.id).join(", ")}`);
    this.port = port;
    this.mode = "interface";
  }

  private save(): void {
    this.device.unsaved = false;
    this.out("Building configuration...\n[OK]\n");
  }

  private help(): void {
    const lines = this.patterns.filter((p) => p.modes.includes(this.mode) && p.help).map((p) => `  ${p.help}`);
    this.out(`Commands here (abbreviations work, for example sh vl br):\n${lines.join("\n")}\n  exit, end\n`);
  }

  private long(id: string): string {
    return id.replace(/^Gi/, "GigabitEthernet");
  }

  private showVlanBrief(): void {
    const rows = this.sim.infra.vlans().map((z) => {
      const ports = this.device.ports.filter((p) => this.sim.infra.pvid(p) === z.vlan).map((p) => p.id);
      return `${String(z.vlan).padEnd(4)} ${z.name.padEnd(32)} ${"active".padEnd(9)} ${ports.join(", ")}`;
    });
    this.out(`VLAN Name                             Status    Ports\n---- -------------------------------- --------- -------------------------------\n${rows.join("\n")}\n`);
  }

  private showStatus(): void {
    const rows = this.device.ports.map((p) => {
      const status = p.shutdown ? "disabled" : p.host ? (p.members.has(this.sim.infra.pvid(p)) ? "connected" : "err-disabled") : "notconnect";
      return `${p.id.padEnd(9)} ${(p.name ?? p.host ?? "").slice(0, 18).padEnd(18)} ${status.padEnd(12)} ${String(this.sim.infra.pvid(p)).padEnd(6)} a-full a-1000 10/100/1000BaseTX`;
    });
    this.out(`Port      Name               Status       Vlan   Duplex Speed  Type\n${rows.join("\n")}\n`);
  }

  private showRunning(): void {
    const out: string[] = ["Building configuration...", "", "Current configuration:", "!", `hostname ${this.device.hostname}`, "!"];
    for (const z of this.sim.infra.vlans()) if (z.vlan !== 1) out.push(`vlan ${z.vlan}`, ` name ${z.name}`, "!");
    for (const p of this.device.ports) {
      out.push(`interface ${this.long(p.id)}`);
      if (p.name ?? p.host) out.push(` description ${p.name ?? p.host}`);
      out.push(" switchport mode access", ` switchport access vlan ${this.sim.infra.pvid(p)}`);
      if (p.shutdown) out.push(" shutdown");
      out.push("!");
    }
    out.push("end");
    this.out(out.join("\n") + "\n");
  }

  private showVersion(): void {
    const d = this.device;
    this.out(`Cisco IOS XE Software, Version ${d.firmware}\n${d.hostname} uptime is 41 weeks, 2 days\ncisco ${d.model} (industrial Ethernet switch)\nManagement IP ${d.ip}\nConfiguration ${d.unsaved ? "modified, not saved (write memory)" : "saved"}\n`);
  }
}
