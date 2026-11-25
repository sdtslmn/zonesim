// Hirschmann HiOS command line, the part a plant network engineer uses:
// VLANs, port VLAN membership, shutting ports, and the show commands.

import type { Sim } from "../sim.js";
import type { SwitchDevice, SwitchPort } from "../infra.js";
import { normalizePort } from "../site.js";
import { UserError } from "../util.js";
import { deviceTokens, matchPattern, firstWords, nextWords, parseVlan, type DeviceSession, type Pattern } from "./session.js";

type Mode = "user" | "priv" | "config" | "interface" | "vlan";
const ANY: Mode[] = ["user", "priv", "config", "interface", "vlan"];
const ENABLED: Mode[] = ["priv", "config", "interface", "vlan"];

export class HiosSession implements DeviceSession {
  done = false;
  private mode: Mode = "user";
  private port?: SwitchPort;
  private out: (t: string) => void = () => {};
  private readonly patterns: Pattern<Mode>[];

  constructor(
    private readonly sim: Sim,
    readonly device: SwitchDevice,
  ) {
    const infra = () => this.sim.infra;
    const sw = device;
    this.patterns = [
      { modes: ["user"], words: ["enable"], run: () => (this.mode = "priv"), help: "enable           privileged mode" },
      { modes: ["priv"], words: ["disable"], run: () => (this.mode = "user") },
      { modes: ["priv"], words: ["configure"], run: () => (this.mode = "config"), help: "configure        global configuration mode" },
      { modes: ["priv"], words: ["vlan", "database"], run: () => (this.mode = "vlan"), help: "vlan database    create, name and delete VLANs" },
      { modes: ["config"], words: ["interface", "<port>"], run: ([p]) => this.enterPort(p), help: "interface 1/3    configure a port" },
      { modes: ["vlan"], words: ["vlan", "add", "<id>"], run: ([v]) => {
        const id = parseVlan(v);
        infra().createVlan(id);
        sw.unsaved = true;
      }, help: "vlan add 30      create VLAN 30" },
      { modes: ["vlan"], words: ["vlan", "delete", "<id>"], run: ([v]) => {
        infra().deleteVlan(parseVlan(v));
        sw.unsaved = true;
      } },
      { modes: ["vlan"], words: ["name", "<id>", "<name...>"], run: ([v, n]) => {
        infra().nameVlan(parseVlan(v), n);
        sw.unsaved = true;
      }, help: "name 30 control  name VLAN 30 (the name becomes the zone name)" },
      { modes: ["interface"], words: ["vlan", "pvid", "<id>"], run: ([v]) => infra().setPvid(sw, this.port!, parseVlan(v)), help: "vlan pvid 30                   untagged frames on this port go to VLAN 30" },
      { modes: ["interface"], words: ["vlan", "participation", "include", "<id>"], run: ([v]) => infra().setMember(sw, this.port!, parseVlan(v), true), help: "vlan participation include 30  make the port a member of VLAN 30" },
      { modes: ["interface"], words: ["vlan", "participation", "exclude", "<id>"], run: ([v]) => infra().setMember(sw, this.port!, parseVlan(v), false) },
      { modes: ["interface"], words: ["vlan", "participation", "auto", "<id>"], run: ([v]) => infra().setMember(sw, this.port!, parseVlan(v), false) },
      { modes: ["interface"], words: ["vlan", "tagging", "<id>"], run: ([v]) => void parseVlan(v) },
      { modes: ["interface"], words: ["no", "vlan", "tagging", "<id>"], run: ([v]) => void parseVlan(v) },
      { modes: ["interface"], words: ["shutdown"], run: () => infra().setShutdown(sw, this.port!, true), help: "shutdown                       disable the port" },
      { modes: ["interface"], words: ["no", "shutdown"], run: () => infra().setShutdown(sw, this.port!, false) },
      { modes: ["interface"], words: ["name", "<text...>"], run: ([t]) => {
        this.port!.name = t.replace(/^"|"$/g, "");
        sw.unsaved = true;
      } },
      { modes: ["priv"], words: ["save"], run: () => this.save(), help: "save             save the running config to flash" },
      { modes: ["priv"], words: ["copy", "config", "running-config", "nvm"], run: () => this.save() },
      { modes: ANY, words: ["show", "vlan", "brief"], run: () => this.showVlanBrief(), help: "show vlan brief  VLANs" },
      { modes: ANY, words: ["show", "vlan", "id", "<id>"], run: ([v]) => this.showVlanId(parseVlan(v)), help: "show vlan id 30  ports of VLAN 30" },
      { modes: ANY, words: ["show", "vlan", "port"], run: () => this.showVlanPort(), help: "show vlan port   PVID of every port" },
      { modes: ANY, words: ["show", "port", "all"], run: () => this.showPorts(), help: "show port all    ports and link state" },
      { modes: ENABLED, words: ["show", "running-config", "script"], run: () => this.showRunning(), help: "show running-config script" },
      { modes: ANY, words: ["show", "system", "info"], run: () => this.showSystem() },
      { modes: ANY, words: ["help"], run: () => this.help() },
      { modes: ANY, words: ["?"], run: () => this.help() },
      { modes: ["user", "priv"], words: ["logout"], run: () => (this.done = true) },
      { modes: ANY, words: ["exit"], run: () => this.exit() },
    ];
  }

  prompt(): string {
    return this.promptText() + " ";
  }

  private promptText(): string {
    const host = `(Hirschmann ${this.device.hostname})`;
    switch (this.mode) {
      case "user":
        return `${host} >`;
      case "priv":
        return `${host} #`;
      case "config":
        return `${host} (Config)#`;
      case "interface":
        return `${host} (Interface ${this.port!.id})#`;
      case "vlan":
        return `${host} (Vlan)#`;
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
      if (m.error.startsWith("ambiguous")) out(`Error: Ambiguous command '${tokens.join(" ")}'.\n`);
      else if (m.error === "incomplete") out(`Error: Incomplete command. Type help for the commands of this mode.\n`);
      else out(`Error: Invalid command '${tokens.join(" ")}'.\n`);
      return;
    }
    try {
      m.pattern.run(m.args);
    } catch (e) {
      if (e instanceof UserError) out(`Error: ${e.message}\n`);
      else throw e;
    }
  }

  private exit(): void {
    if (this.mode === "interface") this.mode = "config";
    else if (this.mode === "config" || this.mode === "vlan") this.mode = "priv";
    else if (this.mode === "priv") this.mode = "user";
    else this.done = true;
  }

  private enterPort(text: string): void {
    const id = normalizePort("hirschmann", text);
    const port = id ? this.device.ports.find((p) => p.id === id) : undefined;
    if (!port) throw new UserError(`Interface ${text} does not exist. Ports: ${this.device.ports.map((p) => p.id).join(", ")}`);
    this.port = port;
    this.mode = "interface";
  }

  private save(): void {
    this.device.unsaved = false;
    this.out("Configuration saved to non-volatile memory.\n");
  }

  private help(): void {
    const lines = this.patterns.filter((p) => p.modes.includes(this.mode) && p.help).map((p) => `  ${p.help}`);
    this.out(`Commands in this mode (keywords can be shortened, for example sh vl br):\n${lines.join("\n")}\n  exit             leave this mode${this.mode === "user" ? " and log out" : ""}\n`);
  }

  private zoneName(vlan: number): string {
    const z = this.sim.net.zoneByVlan(vlan);
    return vlan === 1 && z ? (z.name === "default" ? "default" : z.name) : z?.name ?? `VLAN${vlan}`;
  }

  private showVlanBrief(): void {
    const vlans = this.sim.infra.vlans();
    const rows = vlans.map((z) => `${String(z.vlan).padStart(7)} ${z.name.padEnd(32)} ${(z.vlan === 1 ? "default" : "static").padEnd(9)}`);
    this.out(`Max. VLAN ID................................. 4042\nNumber of currently configured VLANs......... ${vlans.length}\nvlan unaware mode............................ disabled\n\nVLAN ID VLAN Name                        VLAN Type\n------- -------------------------------- ---------\n${rows.join("\n")}\n`);
  }

  private showVlanId(vlan: number): void {
    const z = this.sim.net.zoneByVlan(vlan);
    if (!z) throw new UserError(`VLAN ${vlan} does not exist`);
    const rows = this.device.ports.map((p) => {
      const member = p.members.has(vlan);
      return `${p.id.padEnd(9)} ${(member ? "Include" : "-").padEnd(9)} ${(member ? "Include" : "Autodetect").padEnd(10)} ${member ? "Untagged" : ""}`;
    });
    this.out(`VLAN ID      : ${vlan}\nVLAN Name    : ${this.zoneName(vlan)}\nVLAN Type    : ${vlan === 1 ? "Default" : "Static"}\n\nInterface Current   Configured Tagging\n--------- --------- ---------- --------\n${rows.join("\n")}\n`);
  }

  private showVlanPort(): void {
    const rows = this.device.ports.map((p) => `${p.id.padEnd(9)} ${String(this.sim.infra.pvid(p)).padStart(4)}  ${[...p.members].sort((a, b) => a - b).join(",").padEnd(12)} ${p.host ?? ""}`);
    this.out(`Interface PVID  Member of    Connected\n--------- ----  ------------ ---------\n${rows.join("\n")}\n`);
  }

  private showPorts(): void {
    const rows = this.device.ports.map((p) => {
      const link = p.shutdown ? "down" : p.host ? "up" : "down";
      return `${p.id.padEnd(9)} ${(p.name ?? p.host ?? "").padEnd(16)} ${(p.shutdown ? "disabled" : "enabled").padEnd(8)} ${"auto".padEnd(6)} ${link}`;
    });
    this.out(`Interface Name             Admin    Mode   Link\n--------- ---------------- -------- ------ ----\n${rows.join("\n")}\n`);
  }

  private showRunning(): void {
    const out: string[] = ["!", `! ${this.device.model} running configuration (VLAN and port part)`, "!", "vlan database"];
    for (const z of this.sim.infra.vlans()) {
      if (z.vlan !== 1) out.push(`vlan add ${z.vlan}`);
      out.push(`name ${z.vlan} ${z.name}`);
    }
    out.push("exit", "configure");
    for (const p of this.device.ports) {
      out.push(`interface ${p.id}`);
      if (p.name ?? p.host) out.push(`  name "${p.name ?? p.host}"`);
      for (const v of [...p.members].sort((a, b) => a - b)) out.push(`  vlan participation include ${v}`);
      if (!p.members.has(1)) out.push("  vlan participation exclude 1");
      out.push(`  vlan pvid ${this.sim.infra.pvid(p)}`);
      if (p.shutdown) out.push("  shutdown");
      out.push("  exit");
    }
    out.push("exit");
    this.out(out.join("\n") + "\n");
  }

  private showSystem(): void {
    const d = this.device;
    this.out(`System Name.................... ${d.hostname}\nSystem Description............. Hirschmann ${d.model}\nFirmware Software Release...... HiOS ${d.firmware}\nIP Address (management)........ ${d.ip}\nConfiguration state............ ${d.unsaved ? "changed, not saved (save)" : "saved"}\n`);
  }
}
