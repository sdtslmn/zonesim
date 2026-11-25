// FortiGate command line (FortiOS syntax), the part an OT firewall engineer
// uses: policies between interfaces, addresses, services, application
// control lists for Modbus function codes, the IPS signature setting, and
// the traffic log.
//
// One simplification: "set application" takes signature names. A real
// FortiGate takes signature IDs on the CLI and shows names in the GUI.

import type { Sim } from "../sim.js";
import { MODBUS_SIGNATURES, MODBUS_BASE, FW_SERVICES, type FirewallDevice, type PolicyDraft, type AppList, type AppEntry, type Exclude as ExcludeMode } from "../infra.js";
import { UserError, clock } from "../util.js";
import { deviceTokens, type DeviceSession } from "./session.js";

type Ctx =
  | { kind: "table"; path: string }
  | { kind: "policy"; draft: PolicyDraft }
  | { kind: "address"; name: string; host?: string; comment?: string; isNew: boolean }
  | { kind: "service"; name: string; port?: number; isNew: boolean }
  | { kind: "applist"; list: AppList; isNew: boolean }
  | { kind: "entries"; list: AppList }
  | { kind: "entry"; list: AppList; entry: AppEntry; isNew: boolean }
  | { kind: "ips"; exclude: ExcludeMode }
  | { kind: "iface"; name: string };

const TABLES = ["firewall policy", "firewall address", "firewall service custom", "application list", "system interface"];
const SETTINGS = ["ips global"];
const SIG_NAMES = [MODBUS_BASE, ...MODBUS_SIGNATURES.map((s) => s.name)];

const cloneList = (l: AppList): AppList => ({ ...l, entries: l.entries.map((e) => ({ ...e, application: [...e.application] })) });
const fail = (code = -61) => new UserError(`Command fail. Return code ${code}`);
const parseError = (word: string) => new UserError(`command parse error before '${word}'\nCommand fail. Return code -61`);

export class FortiosSession implements DeviceSession {
  done = false;
  private stack: Ctx[] = [];
  private out: (t: string) => void = () => {};

  constructor(
    private readonly sim: Sim,
    readonly device: FirewallDevice,
  ) {}

  private get infra() {
    return this.sim.infra;
  }

  private get top(): Ctx | undefined {
    return this.stack[this.stack.length - 1];
  }

  prompt(): string {
    const h = this.device.hostname;
    const t = this.top;
    if (!t) return `${h} # `;
    switch (t.kind) {
      case "table":
        return `${h} (${t.path.split(" ").pop()}) # `;
      case "policy":
        return `${h} (${t.draft.id}) # `;
      case "address":
      case "service":
      case "iface":
        return `${h} (${t.name}) # `;
      case "applist":
        return `${h} (${t.list.name}) # `;
      case "entries":
        return `${h} (entries) # `;
      case "entry":
        return `${h} (${t.entry.id}) # `;
      case "ips":
        return `${h} (global) # `;
    }
  }

  words(): string[] {
    const t = this.top;
    if (!t) return ["config", "show", "get", "execute", "diagnose", "exit"];
    if (t.kind === "table" || t.kind === "entries") return ["edit", "delete", "show", "end", ...(t.kind === "table" && t.path === "firewall policy" ? ["move"] : [])];
    return ["set", "unset", "append", "show", "next", "end", "abort", ...(t.kind === "applist" ? ["config"] : [])];
  }

  complete(words: string[]): string[] {
    const typed = words.slice(0, -1);
    const t = this.top;
    const [cmd, field] = typed;
    if (!t) {
      const second: Record<string, string[]> = { firewall: ["policy", "address", "service"], application: ["list"], ips: ["global"], system: cmd === "get" ? ["status", "interface"] : ["interface"] };
      if (cmd === "config" || cmd === "show" || cmd === "get") {
        if (typed.length === 1) return Object.keys(second);
        if (typed.length === 2) return second[typed[1]] ?? [];
        if (typed.length === 3 && typed[1] === "firewall" && typed[2] === "service") return ["custom"];
        return [];
      }
      if (cmd === "execute") return typed.length === 1 ? ["log"] : ["display"];
      if (cmd === "diagnose") return typed.length === 1 ? ["firewall"] : typed.length === 2 ? ["policy"] : ["hits"];
      return [];
    }
    if (t.kind === "table" && cmd === "edit") {
      if (t.path === "firewall policy") return ["0", ...this.infra.policies().map((p) => String(p.id))];
      if (t.path === "application list") return [...this.device.appLists.keys()];
      if (t.path === "system interface") return this.infra.interfaces().map((i) => i.name);
      if (t.path === "firewall address") return this.infra.addressTable().map((a) => a.name).filter((n) => n !== "all");
      return [...this.device.services.keys()];
    }
    if (cmd !== "set" && cmd !== "append" && cmd !== "unset") return [];
    const fields: Partial<Record<Ctx["kind"], string[]>> = {
      policy: ["name", "srcintf", "dstintf", "srcaddr", "dstaddr", "service", "action", "utm-status", "application-list", "logtraffic", "status", "schedule"],
      address: ["subnet"],
      service: ["tcp-portrange"],
      applist: ["other-application-action", "comment"],
      entry: ["application", "action"],
      ips: ["exclude-signatures"],
    };
    if (typed.length === 1) return fields[t.kind] ?? [];
    switch (field) {
      case "srcintf":
      case "dstintf":
        return this.infra.interfaces().map((i) => i.name);
      case "srcaddr":
      case "dstaddr":
        return this.infra.addressTable().map((a) => a.name);
      case "service":
        return [...Object.keys(FW_SERVICES), ...this.device.services.keys()];
      case "application":
        return SIG_NAMES;
      case "application-list":
        return [...this.device.appLists.keys()];
      case "action":
        return t.kind === "entry" ? ["pass", "block", "monitor", "reset"] : ["accept", "deny"];
      case "utm-status":
      case "status":
        return ["enable", "disable"];
      case "logtraffic":
        return ["all", "utm", "disable"];
      case "exclude-signatures":
        return ["none", "industrial", "ot"];
      case "other-application-action":
        return ["pass", "block"];
      default:
        return [];
    }
  }

  run(line: string, out: (t: string) => void): void {
    this.out = out;
    const words = deviceTokens(line);
    if (!words.length) return;
    try {
      this.dispatch(words);
    } catch (e) {
      if (e instanceof UserError) out(`${e.message}\n`);
      else throw e;
    }
  }

  // ------------------------------------------------------------ dispatch

  private dispatch(w: string[]): void {
    const [cmd, ...rest] = w;
    const t = this.top;
    if (cmd === "?" || cmd === "help") return this.help();
    if (!t) return this.topLevel(cmd, rest);
    if (cmd === "show" || cmd === "get") return this.out(this.render(t));
    if (t.kind === "table" || t.kind === "entries") return this.inTable(t, cmd, rest);
    return this.inObject(t, cmd, rest);
  }

  private topLevel(cmd: string, rest: string[]): void {
    switch (cmd) {
      case "config": {
        const path = rest.join(" ");
        if (TABLES.includes(path)) this.stack.push({ kind: "table", path });
        else if (path === "ips global") this.stack.push({ kind: "ips", exclude: this.device.exclude });
        else throw parseError(rest[0] ?? "config");
        return;
      }
      case "show":
        return this.show(rest.join(" "));
      case "get":
        if (rest.join(" ") === "system status") return this.systemStatus();
        if (rest.join(" ") === "system interface") return this.show("system interface");
        return this.show(rest.join(" "));
      case "execute":
        if (rest[0] === "log" && rest[1] === "display") return this.logDisplay();
        throw parseError(rest[0] ?? "execute");
      case "diagnose":
        if (rest.join(" ") === "firewall policy hits" || rest.join(" ") === "firewall iprope show") return this.policyHits();
        throw parseError(rest[0] ?? "diagnose");
      case "exit":
      case "quit":
        this.done = true;
        return;
      case "end":
      case "next":
        return;
      default:
        this.out("Unknown action 0\n");
        throw fail(-1);
    }
  }

  private inTable(t: Extract<Ctx, { kind: "table" } | { kind: "entries" }>, cmd: string, rest: string[]): void {
    const key = rest[0];
    switch (cmd) {
      case "edit": {
        if (key === undefined) throw parseError("edit");
        if (t.kind === "entries") return this.editEntry(t.list, key);
        return this.editIn(t.path, key);
      }
      case "delete":
        if (key === undefined) throw parseError("delete");
        return this.deleteIn(t, key);
      case "move":
        if (t.kind === "table" && t.path === "firewall policy" && rest.length === 3 && (rest[1] === "before" || rest[1] === "after")) {
          this.infra.movePolicy(parseInt(rest[0], 10), rest[1], parseInt(rest[2], 10));
          return;
        }
        throw parseError(rest[0] ?? "move");
      case "end":
        this.stack.pop();
        return;
      case "next":
        return;
      case "abort":
        this.stack.pop();
        return;
      default:
        throw parseError(cmd);
    }
  }

  private editIn(path: string, key: string): void {
    switch (path) {
      case "firewall policy": {
        const id = parseInt(key, 10);
        if (!/^\d+$/.test(key)) throw parseError(key);
        const realId = id === 0 ? this.infra.freePolicyId() : id;
        const existing = this.infra.policy(realId);
        const draft: PolicyDraft = existing ? { ...existing, srcintf: [...existing.srcintf], dstintf: [...existing.dstintf], srcaddr: [...existing.srcaddr], dstaddr: [...existing.dstaddr], service: [...existing.service] } : this.infra.newPolicyDraft(realId);
        if (!existing) this.out(`new entry '${realId}' added\n`);
        delete (draft as Partial<{ rules: unknown }>).rules;
        this.stack.push({ kind: "policy", draft });
        return;
      }
      case "firewall address": {
        const own = this.device.addresses.get(key);
        const host = this.sim.net.hosts.find((h) => h.name === key);
        if (key === "all") throw new UserError("The address 'all' is built in.");
        if (!own && !host) this.out(`new entry '${key}' added\n`);
        this.stack.push({ kind: "address", name: key, host: own ?? host?.name, isNew: !own && !host });
        return;
      }
      case "firewall service custom": {
        if (FW_SERVICES[key.toUpperCase()] && key !== "MODBUS") throw new UserError(`'${key}' is a predefined service.`);
        const existing = this.device.services.get(key) ?? (key === "MODBUS" ? "tcp/502" : undefined);
        if (!existing) this.out(`new entry '${key}' added\n`);
        const port = existing ? parseInt(existing.split("/")[1], 10) : undefined;
        this.stack.push({ kind: "service", name: key, port, isNew: !existing });
        return;
      }
      case "application list": {
        const existing = this.device.appLists.get(key);
        const list: AppList = existing ? cloneList(existing) : { name: key, otherAction: "pass", entries: [] };
        if (!existing) this.out(`new entry '${key}' added\n`);
        this.stack.push({ kind: "applist", list, isNew: !existing });
        return;
      }
      case "system interface": {
        if (!this.infra.interfaces().some((i) => i.name === key)) throw new UserError("entry not found in datasource\nCommand fail. Return code -3");
        this.stack.push({ kind: "iface", name: key });
        return;
      }
    }
  }

  private editEntry(list: AppList, key: string): void {
    if (!/^\d+$/.test(key)) throw parseError(key);
    let id = parseInt(key, 10);
    if (id === 0) id = Math.max(0, ...list.entries.map((e) => e.id)) + 1;
    const existing = list.entries.find((e) => e.id === id);
    if (!existing) this.out(`new entry '${id}' added\n`);
    this.stack.push({ kind: "entry", list, entry: existing ? { ...existing, application: [...existing.application] } : { id, application: [], action: "block" }, isNew: !existing });
  }

  private deleteIn(t: Extract<Ctx, { kind: "table" } | { kind: "entries" }>, key: string): void {
    if (t.kind === "entries") {
      const before = t.list.entries.length;
      t.list.entries = t.list.entries.filter((e) => String(e.id) !== key);
      if (t.list.entries.length === before) throw new UserError("entry not found in datasource\nCommand fail. Return code -3");
      return;
    }
    switch (t.path) {
      case "firewall policy":
        if (!this.infra.deletePolicy(parseInt(key, 10))) throw new UserError("entry not found in datasource\nCommand fail. Return code -3");
        return;
      case "firewall address":
        if (!this.device.addresses.delete(key)) throw new UserError(this.sim.net.host(key) ? `The address '${key}' belongs to a host and stays while the host exists.` : "entry not found in datasource\nCommand fail. Return code -3");
        return;
      case "firewall service custom":
        if (this.inUse("service", key)) throw new UserError("Command fail. Return code -23 (the service is used by a policy)");
        if (!this.device.services.delete(key)) throw new UserError("entry not found in datasource\nCommand fail. Return code -3");
        return;
      case "application list":
        if (this.inUse("applist", key)) throw new UserError("Command fail. Return code -23 (the list is used by a policy)");
        if (!this.device.appLists.delete(key)) throw new UserError("entry not found in datasource\nCommand fail. Return code -3");
        return;
      default:
        throw fail();
    }
  }

  private inUse(what: "service" | "applist", name: string): boolean {
    return this.infra.policies().some((p) => (what === "service" ? p.service.includes(name) : p.appList === name));
  }

  // ------------------------------------------------------------ objects

  private inObject(t: Exclude<Ctx, { kind: "table" } | { kind: "entries" }>, cmd: string, rest: string[]): void {
    switch (cmd) {
      case "set":
      case "append":
      case "unset":
        return this.setField(t, cmd, rest[0], rest.slice(1));
      case "config":
        if (t.kind === "applist" && rest[0] === "entries") {
          this.stack.push({ kind: "entries", list: t.list });
          return;
        }
        throw parseError(rest[0] ?? "config");
      case "next":
        this.commit(t);
        this.stack.pop();
        return;
      case "end":
        this.commit(t);
        this.stack.pop();
        if (this.top?.kind === "table" || this.top?.kind === "entries") this.stack.pop();
        return;
      case "abort":
        this.stack.pop();
        return;
      default:
        throw parseError(cmd);
    }
  }

  private setField(t: Exclude<Ctx, { kind: "table" } | { kind: "entries" }>, how: "set" | "append" | "unset", field: string | undefined, values: string[]): void {
    if (!field) throw parseError(how);
    if (how !== "unset" && !values.length) throw new UserError(`Attribute '${field}' needs a value.\nCommand fail. Return code -61`);
    const one = (allowed: string[]) => {
      if (values.length !== 1 || !allowed.includes(values[0])) throw parseError(values[0] ?? field);
      return values[0];
    };
    switch (t.kind) {
      case "policy": {
        const d = t.draft;
        const list = (key: "srcintf" | "dstintf" | "srcaddr" | "dstaddr" | "service") => {
          for (const v of how === "unset" ? [] : values) {
            const known = key.endsWith("intf") ? this.infra.interfaces().some((i) => i.name === v) : key === "service" ? !!this.infra.resolveService(v) : !!this.infra.resolveAddress(v);
            if (!known) throw new UserError(`entry not found in datasource\n\nvalue parse error before '${v}'\nCommand fail. Return code -3`);
          }
          if (how === "unset") d[key] = [];
          else if (how === "append") d[key] = [...new Set([...d[key], ...values])];
          else d[key] = [...values];
        };
        switch (field) {
          case "name":
            d.name = how === "unset" ? "" : values.join(" ");
            return;
          case "srcintf":
          case "dstintf":
          case "srcaddr":
          case "dstaddr":
          case "service":
            return list(field);
          case "action":
            d.action = how === "unset" ? "deny" : (one(["accept", "deny"]) as "accept" | "deny");
            return;
          case "status":
            d.status = how === "unset" ? "enable" : (one(["enable", "disable"]) as "enable" | "disable");
            return;
          case "utm-status":
            d.utm = how === "unset" ? false : one(["enable", "disable"]) === "enable";
            return;
          case "application-list":
            if (how !== "unset" && !this.device.appLists.has(values[0])) throw new UserError(`entry not found in datasource\n\nvalue parse error before '${values[0]}'\nCommand fail. Return code -3`);
            d.appList = how === "unset" ? undefined : values[0];
            return;
          case "logtraffic":
            d.logtraffic = how === "unset" ? "utm" : one(["all", "utm", "disable"]);
            return;
          case "schedule":
            if (how !== "unset") one(["always"]);
            return;
          case "nat":
          case "comments":
          case "ips-sensor":
          case "inspection-mode":
            return;
          default:
            throw parseError(field);
        }
      }
      case "address":
        if (field === "subnet") {
          const ip = values[0]?.split("/")[0];
          const mask = values[1] ?? (values[0]?.includes("/") ? values[0].split("/")[1] : "255.255.255.255");
          if (mask !== "255.255.255.255" && mask !== "32") throw new UserError("ZoneSim supports host addresses only (a /32 mask, 255.255.255.255).");
          const host = this.sim.net.hosts.find((h) => h.ip === ip);
          if (!host) throw new UserError(`No host has the address ${ip}. ZoneSim supports addresses of the plant's hosts.`);
          t.host = host.name;
          return;
        }
        if (field === "comment" || field === "type" || field === "associated-interface") return;
        throw parseError(field);
      case "service":
        if (field === "tcp-portrange") {
          const port = parseInt(values[0], 10);
          if (!(port > 0 && port < 65536)) throw parseError(values[0]);
          t.port = port;
          return;
        }
        if (field === "protocol" || field === "category" || field === "comment") return;
        throw parseError(field);
      case "applist":
        if (field === "other-application-action") {
          t.list.otherAction = how === "unset" ? "pass" : (one(["pass", "block"]) as "pass" | "block");
          return;
        }
        if (field === "comment") {
          t.list.comment = values.join(" ");
          return;
        }
        if (field === "unknown-application-action" || field === "other-application-log" || field === "extended-log") return;
        throw parseError(field);
      case "entry":
        if (field === "application") {
          for (const v of values) if (!SIG_NAMES.includes(v)) throw new UserError(`entry not found in datasource\nvalue parse error before '${v}'\nModbus signatures: ${SIG_NAMES.join(" ")}`);
          if (how === "unset") t.entry.application = [];
          else if (how === "append") t.entry.application = [...new Set([...t.entry.application, ...values])];
          else t.entry.application = [...values];
          return;
        }
        if (field === "action") {
          t.entry.action = how === "unset" ? "block" : (one(["pass", "block", "monitor", "reset"]) as AppEntry["action"]);
          return;
        }
        if (field === "category" || field === "log" || field === "parameters") return;
        throw parseError(field);
      case "ips":
        if (field === "exclude-signatures") {
          t.exclude = how === "unset" ? "ot" : (one(["none", "industrial", "ot"]) as ExcludeMode);
          return;
        }
        throw parseError(field);
      case "iface":
        if (["alias", "description", "allowaccess", "role"].includes(field)) return;
        throw new UserError("ZoneSim keeps interfaces in step with the VLANs on the switches. Create a VLAN there to add one.");
    }
  }

  private commit(t: Exclude<Ctx, { kind: "table" } | { kind: "entries" }>): void {
    switch (t.kind) {
      case "policy": {
        const notes = this.infra.commitPolicy(t.draft);
        for (const n of notes) this.out(`  note: ${n}\n`);
        return;
      }
      case "address":
        if (t.isNew) {
          if (!t.host) throw new UserError("Attribute 'subnet' MUST be set.\nCommand fail. Return code -61");
          this.device.addresses.set(t.name, t.host);
        }
        return;
      case "service":
        if (!t.port) throw new UserError("Attribute 'tcp-portrange' MUST be set.\nCommand fail. Return code -61");
        if (t.name !== "MODBUS") this.device.services.set(t.name, `tcp/${t.port}`);
        return;
      case "applist":
        this.device.appLists.set(t.list.name, t.list);
        this.infra.refreshAppControl();
        return;
      case "entry": {
        const list = t.list;
        list.entries = list.entries.filter((e) => e.id !== t.entry.id);
        list.entries.push(t.entry);
        list.entries.sort((a, b) => a.id - b.id);
        return;
      }
      case "ips":
        this.device.exclude = t.exclude;
        this.infra.refreshAppControl();
        return;
      case "iface":
        return;
    }
  }

  // ------------------------------------------------------------ output

  private help(): void {
    const t = this.top;
    if (!t) {
      this.out(`config firewall policy          edit policies (edit 0 creates one)
config firewall address         address objects (one per host is built in)
config firewall service custom  services (HTTP, HTTPS, SSH, RDP, PING, MODBUS, ALL are built in)
config application list         application control lists for Modbus function codes
config ips global               set exclude-signatures none loads the OT signatures
show firewall policy [ID]       show the configuration, also address, service custom, application list
get system status               model, firmware, signature status
execute log display             recent traffic through the firewall
diagnose firewall policy hits   how often each policy matched
exit                            log out
`);
      return;
    }
    if (t.kind === "table" || t.kind === "entries") {
      this.out(`edit ID|NAME   add or change an entry${t.kind === "table" && t.path === "firewall policy" ? " (edit 0 picks a free ID)\nmove ID before|after ID" : ""}\ndelete ID|NAME\nshow\nend            leave\n`);
      return;
    }
    const fields: Record<string, string> = {
      policy: "name, srcintf, dstintf, srcaddr, dstaddr, service, action accept|deny, utm-status enable|disable, application-list, logtraffic, status",
      address: "subnet A.B.C.D 255.255.255.255",
      service: "tcp-portrange PORT",
      applist: "other-application-action pass|block, comment; config entries",
      entry: `application NAME..., action pass|block|monitor|reset\nSignatures: ${SIG_NAMES.join(" ")}`,
      ips: "exclude-signatures none|industrial|ot",
      iface: "(read only in ZoneSim)",
    };
    this.out(`set FIELD VALUE..., append FIELD VALUE..., unset FIELD\nnext (save), end (save and leave), abort (discard)\nFields: ${fields[t.kind]}\n`);
  }

  private q(v: string): string {
    return `"${v}"`;
  }

  private policyText(p: { id: number; name: string; srcintf: string[]; dstintf: string[]; srcaddr: string[]; dstaddr: string[]; service: string[]; action: string; status: string; utm: boolean; appList?: string; logtraffic: string }, indent = "    "): string {
    const i2 = indent + "    ";
    const lines = [`${indent}edit ${p.id}`];
    if (p.name) lines.push(`${i2}set name ${this.q(p.name)}`);
    lines.push(`${i2}set srcintf ${p.srcintf.map((x) => this.q(x)).join(" ")}`, `${i2}set dstintf ${p.dstintf.map((x) => this.q(x)).join(" ")}`);
    if (p.action === "accept") lines.push(`${i2}set action accept`);
    lines.push(`${i2}set srcaddr ${p.srcaddr.map((x) => this.q(x)).join(" ")}`, `${i2}set dstaddr ${p.dstaddr.map((x) => this.q(x)).join(" ")}`, `${i2}set schedule "always"`, `${i2}set service ${p.service.map((x) => this.q(x)).join(" ")}`);
    if (p.utm) lines.push(`${i2}set utm-status enable`);
    if (p.appList) lines.push(`${i2}set application-list ${this.q(p.appList)}`);
    if (p.logtraffic !== "utm") lines.push(`${i2}set logtraffic ${p.logtraffic}`);
    if (p.status === "disable") lines.push(`${i2}set status disable`);
    lines.push(`${indent}next`);
    return lines.join("\n");
  }

  private appListText(l: AppList, indent = "    "): string {
    const i2 = indent + "    ";
    const i3 = i2 + "    ";
    const lines = [`${indent}edit ${this.q(l.name)}`];
    if (l.comment) lines.push(`${i2}set comment ${this.q(l.comment)}`);
    if (l.otherAction !== "pass") lines.push(`${i2}set other-application-action ${l.otherAction}`);
    if (l.entries.length) {
      lines.push(`${i2}config entries`);
      for (const e of l.entries) {
        lines.push(`${i3}edit ${e.id}`);
        if (e.application.length) lines.push(`${i3}    set application ${e.application.join(" ")}`);
        lines.push(`${i3}    set action ${e.action}`, `${i3}next`);
      }
      lines.push(`${i2}end`);
    }
    lines.push(`${indent}next`);
    return lines.join("\n");
  }

  private render(t: Ctx): string {
    switch (t.kind) {
      case "table":
        return this.section(t.path) + "\n";
      case "policy":
        return `config firewall policy\n${this.policyText(t.draft)}\nend\n`;
      case "address": {
        const h = t.host ? this.sim.net.host(t.host) : undefined;
        return `config firewall address\n    edit ${this.q(t.name)}\n        set subnet ${h ? `${h.ip} 255.255.255.255` : "0.0.0.0 0.0.0.0"}\n    next\nend\n`;
      }
      case "service":
        return `config firewall service custom\n    edit ${this.q(t.name)}\n        set tcp-portrange ${t.port ?? ""}\n    next\nend\n`;
      case "applist":
        return `config application list\n${this.appListText(t.list)}\nend\n`;
      case "entries":
        return `config entries\n${t.list.entries.map((e) => `    edit ${e.id}\n        set application ${e.application.join(" ")}\n        set action ${e.action}\n    next`).join("\n")}\nend\n`;
      case "entry":
        return `edit ${t.entry.id}\n    set application ${t.entry.application.join(" ")}\n    set action ${t.entry.action}\nnext\n`;
      case "ips":
        return `config ips global\n    set exclude-signatures ${t.exclude}\nend\n`;
      case "iface":
        return this.section("system interface", t.name) + "\n";
    }
  }

  private section(path: string, only?: string): string {
    switch (path) {
      case "firewall policy": {
        const ps = this.infra.policies().filter((p) => only === undefined || String(p.id) === only);
        return `config firewall policy\n${ps.map((p) => this.policyText(p)).join("\n")}${ps.length ? "\n" : ""}end`;
      }
      case "firewall address": {
        const rows = this.infra.addressTable().filter((a) => a.name !== "all");
        return `config firewall address\n    edit "all"\n    next\n${rows.map((a) => `    edit ${this.q(a.name)}\n        set subnet ${a.host?.ip ?? "0.0.0.0"} 255.255.255.255\n    next`).join("\n")}\nend`;
      }
      case "firewall service custom": {
        const rows: [string, string][] = [["MODBUS", "tcp/502"], ...[...this.device.services].filter(([n]) => n !== "MODBUS")];
        return `config firewall service custom\n${rows.map(([n, v]) => `    edit ${this.q(n)}\n        set tcp-portrange ${v.split("/")[1]}\n    next`).join("\n")}\nend`;
      }
      case "application list": {
        const lists = [...this.device.appLists.values()].filter((l) => only === undefined || l.name === only);
        return `config application list\n${lists.map((l) => this.appListText(l)).join("\n")}${lists.length ? "\n" : ""}end`;
      }
      case "system interface": {
        const rows = this.infra.interfaces().filter((i) => only === undefined || i.name === only).map((i) => {
          const h = this.sim.net.hostsIn(i.name)[0];
          const gw = h ? `${h.ip.split(".").slice(0, 3).join(".")}.1 255.255.255.0` : "0.0.0.0 0.0.0.0";
          return i.type === "vlan"
            ? `    edit ${this.q(i.name)}\n        set vdom "root"\n        set ip ${gw}\n        set allowaccess ping\n        set interface "internal"\n        set vlanid ${i.vlan}\n    next`
            : `    edit ${this.q(i.name)}\n        set vdom "root"\n        set ip ${gw}\n        set type physical\n        set alias ${this.q(i.port ?? "")}\n    next`;
        });
        return `config system interface\n${rows.join("\n")}\nend`;
      }
      case "ips global":
        return `config ips global\n    set exclude-signatures ${this.device.exclude}\nend`;
      default:
        throw parseError(path.split(" ")[0] || "show");
    }
  }

  private show(what: string): void {
    if (!what) {
      this.out([...TABLES, ...SETTINGS].map((p) => this.section(p)).join("\n") + "\n");
      return;
    }
    const m = what.match(/^(firewall policy|application list|system interface)\s+(\S+)$/);
    if (m) {
      this.out(this.section(m[1], m[2].replace(/^"|"$/g, "")) + "\n");
      return;
    }
    if (![...TABLES, ...SETTINGS].includes(what)) throw parseError(what.split(" ")[0]);
    this.out(this.section(what) + "\n");
  }

  private systemStatus(): void {
    const d = this.device;
    this.out(`Version: ${d.model.replace(/\s+/g, "-")} ${d.firmware},build2662 (GA)
Serial-Number: FGR60F${d.ip.split(".").map((x) => x.padStart(3, "0")).join("").slice(-8)}
IPS & Application Control: ${d.exclude === "none" ? "OT signatures loaded" : `OT signatures excluded (exclude-signatures ${d.exclude})`}
Hostname: ${d.hostname}
Operation Mode: NAT
Current virtual domain: root
Management IP: ${d.ip}
Policies: ${this.infra.policies().length}
`);
  }

  private logDisplay(): void {
    const sim = this.sim;
    // Traffic inside one zone never reaches the firewall, and a host with its switch port down never sends.
    const crossing = sim.events.filter((e) => e.srcZone !== undefined && e.srcZone !== e.dstZone && !/ is cut off/.test(e.reason));
    const recent = crossing.slice(-20);
    if (!recent.length) {
      this.out("No traffic crossed the firewall yet. Traffic inside one zone never reaches it.\n");
      return;
    }
    const base = new Date("2026-11-25T08:00:00Z").getTime();
    for (const e of recent) {
      const s = sim.net.host(e.src);
      const d = sim.net.host(e.dst);
      const when = new Date(base + e.t * 1000).toISOString();
      const c = e.conduit ? sim.net.conduit(e.conduit) : undefined;
      const policy = c && e.rule ? c.rules[e.rule - 1]?.id ?? 0 : 0;
      const sig = e.service === "modbus" && e.fc !== undefined ? MODBUS_SIGNATURES.find((x) => x.fc === e.fc)?.name ?? MODBUS_BASE : undefined;
      const appBlocked = !e.allowed && /function code/.test(e.reason);
      const action = appBlocked ? "block" : e.allowed ? (e.delivered ? "accept" : "server-rst") : "deny";
      this.out(
        `date=${when.slice(0, 10)} time=${when.slice(11, 19)} devname="${this.device.hostname}" type="${appBlocked ? "utm" : "traffic"}" subtype="${appBlocked ? "app-ctrl" : "forward"}" srcip=${s?.ip ?? e.src} srcintf="${e.srcZone}" dstip=${d?.ip ?? e.dst} dstintf="${e.dstZone}" service="${this.infra.serviceName(e.service)}" policyid=${policy} action="${action}"${sig ? ` app="${sig}" appcat="Industrial"` : ""}\n`,
      );
    }
    this.out(`(${recent.length} of ${crossing.length} entries, newest last, plant time ${clock(sim.t)})\n`);
  }

  private policyHits(): void {
    const rows = this.infra.policies().map((p) => `policy ${String(p.id).padEnd(4)} ${p.srcintf.join(",")} -> ${p.dstintf.join(",")}  hits ${p.rules.reduce((n, r) => n + r.rule.hits, 0)}${p.name ? `  (${p.name})` : ""}`);
    this.out((rows.length ? rows.join("\n") : "No policies.") + "\nImplicit deny (policy 0) drops everything else.\n");
  }
}
