// The plant's network devices: one firewall and the switches.
//
// The conduit rules in Network stay the one source of truth for what passes.
// This module gives them a vendor shape and keeps the two in step:
//   - a zone is a VLAN on the switches and an interface on the firewall
//     (zones behind a firewall port, like the internet, are physical ports)
//   - a host's zone follows the VLAN of its switch port
//   - a firewall policy is one or more conduit rules sharing a policy ID
//   - Modbus function code filtering is a FortiGate application control list

import type { Network, Rule, Conduit, Endpoint, Host, Zone } from "./network.js";
import type { Site, SiteFirewall, SiteSwitch, SwitchVendor, FirewallVendor } from "./site.js";
import { portName } from "./site.js";
import { UserError } from "./util.js";

// ---------------------------------------------------------------- FortiGate application control

/** Modbus application signatures, named as FortiGuard names them. */
export const MODBUS_SIGNATURES: { name: string; fc: number }[] = [
  { name: "Modbus_Read.Coils", fc: 1 },
  { name: "Modbus_Read.Discrete.Inputs", fc: 2 },
  { name: "Modbus_Read.Holding.Registers", fc: 3 },
  { name: "Modbus_Read.Input.Registers", fc: 4 },
  { name: "Modbus_Write.Single.Coil", fc: 5 },
  { name: "Modbus_Write.Single.Register", fc: 6 },
  { name: "Modbus_Diagnostics", fc: 8 },
  { name: "Modbus_Write.Multiple.Coils", fc: 15 },
  { name: "Modbus_Write.Multiple.Registers", fc: 16 },
  { name: "Modbus_Read.Device.ID", fc: 43 },
];
/** The protocol signature: matches every Modbus request. */
export const MODBUS_BASE = "Modbus";
const ALL_FCS = MODBUS_SIGNATURES.map((s) => s.fc);

export type AppAction = "pass" | "block" | "monitor" | "reset";

export interface AppEntry {
  id: number;
  application: string[];
  action: AppAction;
}

export interface AppList {
  name: string;
  comment?: string;
  otherAction: "pass" | "block";
  entries: AppEntry[];
}

/** FortiGate service objects and the ZoneSim services they stand for. */
export const FW_SERVICES: Record<string, string> = { ALL: "any", HTTP: "http", HTTPS: "https", SSH: "ssh", RDP: "rdp", PING: "icmp", MODBUS: "modbus" };

export type Exclude = "none" | "industrial" | "ot";

// ---------------------------------------------------------------- devices

export interface SwitchPort {
  id: string;
  host?: string;
  shutdown: boolean;
  /** Untagged VLAN of the port (PVID). For ports with a host it follows the host's zone. */
  pvid: number;
  /** VLANs the port is a member of. */
  members: Set<number>;
  name?: string;
}

export interface SwitchDevice {
  kind: "switch";
  name: string;
  vendor: SwitchVendor;
  model: string;
  firmware: string;
  hostname: string;
  ip: string;
  ports: SwitchPort[];
  /** Changed since the last save. */
  unsaved: boolean;
}

export interface FirewallDevice {
  kind: "firewall";
  name: string;
  vendor: FirewallVendor;
  model: string;
  firmware: string;
  hostname: string;
  ip: string;
  exclude: Exclude;
  appLists: Map<string, AppList>;
  /** Address objects beyond the automatic one per host: name to host. */
  addresses: Map<string, string>;
  /** Custom services: name to "tcp/PORT". */
  services: Map<string, string>;
}

export type NetDevice = SwitchDevice | FirewallDevice;

/** A firewall policy as the FortiGate shows it, built from the rules that share its ID. */
export interface PolicyView {
  id: number;
  name: string;
  srcintf: string[];
  dstintf: string[];
  srcaddr: string[];
  dstaddr: string[];
  service: string[];
  action: "accept" | "deny";
  status: "enable" | "disable";
  utm: boolean;
  appList?: string;
  logtraffic: string;
  /** Rules this policy makes, in order. */
  rules: { conduit: Conduit; rule: Rule; index: number }[];
}

export type PolicyDraft = Omit<PolicyView, "rules">;

const uniq = <T>(a: T[]) => [...new Set(a)];

export class Infra {
  readonly firewall: FirewallDevice;
  readonly switches: SwitchDevice[];

  constructor(
    site: Site,
    readonly net: Network,
  ) {
    const fw: SiteFirewall = site.network.firewall;
    this.firewall = {
      kind: "firewall",
      name: fw.name,
      vendor: fw.vendor,
      model: fw.model,
      firmware: fw.firmware,
      hostname: fw.hostname,
      ip: fw.ip,
      exclude: fw.otSignatures ? "none" : "ot",
      appLists: new Map(),
      addresses: new Map(),
      services: new Map(),
    };
    this.switches = site.network.switches.map((s: SiteSwitch) => ({
      kind: "switch" as const,
      name: s.name,
      vendor: s.vendor,
      model: s.model,
      firmware: s.firmware,
      hostname: s.hostname,
      ip: s.ip,
      unsaved: false,
      ports: s.ports.map((p) => {
        const z = p.host ? net.zone(net.host(p.host)?.zone ?? "") : undefined;
        const vlan = z?.vlan ?? 1;
        return { id: p.id, host: p.host, shutdown: false, pvid: vlan, members: new Set([vlan]) };
      }),
    }));
    for (const sw of this.switches) for (const p of sw.ports) if (p.host) {
      const h = net.host(p.host);
      if (h) h.port = { device: sw.name, port: p.id };
    }
    // Rules from the site file with function code lists get an application control list.
    for (const c of net.conduits) for (const r of c.rules) if (r.fc && !r.appList) r.appList = this.appListFor(r.fc);
    this.refreshAppControl();
    this.refreshLinks();
  }

  get devices(): NetDevice[] {
    return [this.firewall, ...this.switches];
  }

  device(name: string): NetDevice | undefined {
    const n = name.toLowerCase();
    return this.devices.find((d) => d.name === n || d.hostname.toLowerCase() === n);
  }

  // ------------------------------------------------------------ switches and VLANs

  /** VLAN zones in VLAN order. */
  vlans(): Zone[] {
    return this.net.zones.filter((z) => z.vlan !== undefined).sort((a, b) => a.vlan! - b.vlan!);
  }

  switchOf(host: Host): { sw: SwitchDevice; port: SwitchPort } | undefined {
    if (!host.port) return undefined;
    const sw = this.switches.find((s) => s.name === host.port!.device);
    const port = sw?.ports.find((p) => p.id === host.port!.port);
    return sw && port ? { sw, port } : undefined;
  }

  /** Effective PVID of a port: a host's port follows its zone. */
  pvid(port: SwitchPort): number {
    if (port.host) {
      const h = this.net.host(port.host);
      const z = h ? this.net.zone(h.zone) : undefined;
      if (z?.vlan !== undefined) return z.vlan;
    }
    return port.pvid;
  }

  /** Recompute which hosts can talk: port up and a member of its own VLAN. */
  refreshLinks(): void {
    for (const h of this.net.hosts) {
      if (h.down) {
        h.link = false;
        h.linkReason = h.down;
        continue;
      }
      const at = this.switchOf(h);
      if (!at) {
        h.link = true;
        h.linkReason = undefined;
        continue;
      }
      const vlan = this.pvid(at.port);
      if (at.port.shutdown) {
        h.link = false;
        h.linkReason = `port ${at.port.id} on ${at.sw.name} is shut down`;
      } else if (!at.port.members.has(vlan)) {
        h.link = false;
        h.linkReason = `port ${at.port.id} on ${at.sw.name} has PVID ${vlan} but is not a member of VLAN ${vlan}`;
      } else {
        h.link = true;
        h.linkReason = undefined;
      }
    }
  }

  /** Call after the console moves hosts between zones: their ports join the new VLAN only. */
  hostsMoved(hosts: Host[]): void {
    for (const h of hosts) {
      const at = this.switchOf(h);
      const z = this.net.zone(h.zone);
      if (at && z?.vlan !== undefined) {
        at.port.pvid = z.vlan;
        at.port.members = new Set([z.vlan]);
        at.sw.unsaved = true;
      }
    }
    this.refreshLinks();
  }

  /** Create a VLAN, which creates its zone. */
  createVlan(vlan: number, name?: string): Zone {
    if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4042) throw new UserError(`VLAN ID ${vlan} is out of range`);
    const existing = this.net.zoneByVlan(vlan);
    if (existing) return existing;
    const zn = name ? zoneName(name) : `vlan${vlan}`;
    return this.net.createZone(zn, { vlan });
  }

  nameVlan(vlan: number, name: string): Zone {
    const z = this.net.zoneByVlan(vlan);
    if (!z) throw new UserError(`VLAN ${vlan} does not exist`);
    return this.net.renameZone(z.name, zoneName(name));
  }

  deleteVlan(vlan: number): void {
    const z = this.net.zoneByVlan(vlan);
    if (!z) throw new UserError(`VLAN ${vlan} does not exist`);
    if (vlan === 1) throw new UserError("VLAN 1 is the default VLAN and cannot be deleted");
    this.net.deleteZone(z.name);
    for (const sw of this.switches) for (const p of sw.ports) {
      p.members.delete(vlan);
      if (p.pvid === vlan) p.pvid = 1;
    }
  }

  /** Set the untagged VLAN of a port (HiOS: vlan pvid; IOS: switchport access vlan). */
  setPvid(sw: SwitchDevice, port: SwitchPort, vlan: number, opts: { access?: boolean } = {}): void {
    const z = this.net.zoneByVlan(vlan);
    if (!z) throw new UserError(`VLAN ${vlan} does not exist`);
    port.pvid = vlan;
    if (opts.access) port.members = new Set([vlan]);
    if (port.host) this.net.addToZone(z.name, [port.host]);
    sw.unsaved = true;
    this.refreshLinks();
  }

  setMember(sw: SwitchDevice, port: SwitchPort, vlan: number, include: boolean): void {
    if (!this.net.zoneByVlan(vlan)) throw new UserError(`VLAN ${vlan} does not exist`);
    if (include) port.members.add(vlan);
    else port.members.delete(vlan);
    sw.unsaved = true;
    this.refreshLinks();
  }

  setShutdown(sw: SwitchDevice, port: SwitchPort, shut: boolean): void {
    port.shutdown = shut;
    sw.unsaved = true;
    this.refreshLinks();
  }

  // ------------------------------------------------------------ firewall: objects

  /** Interfaces: one per zone, named after it. */
  interfaces(): { name: string; type: "vlan" | "physical"; vlan?: number; port?: string; zone: Zone }[] {
    return this.net.zones.map((z) => (z.vlan !== undefined ? { name: z.name, type: "vlan" as const, vlan: z.vlan, zone: z } : { name: z.name, type: "physical" as const, port: z.port ?? "port1", zone: z }));
  }

  /** Address objects: "all", one per host, and any added on the firewall. */
  addressTable(): { name: string; host?: Host }[] {
    const out: { name: string; host?: Host }[] = [{ name: "all" }];
    for (const h of this.net.hosts) out.push({ name: h.name, host: h });
    for (const [name, host] of this.firewall.addresses) out.push({ name, host: this.net.host(host) });
    return out;
  }

  resolveAddress(name: string): Host | "all" | undefined {
    if (name === "all") return "all";
    const own = this.firewall.addresses.get(name);
    if (own) return this.net.host(own);
    return this.net.hosts.find((h) => h.name === name);
  }

  /** Service object name to ZoneSim service. */
  resolveService(name: string): string | undefined {
    const up = name.toUpperCase();
    if (FW_SERVICES[up]) return FW_SERVICES[up];
    return this.firewall.services.get(name);
  }

  serviceName(service: string): string {
    const named = Object.entries(FW_SERVICES).find(([, v]) => v === service);
    if (named) return named[0];
    const custom = [...this.firewall.services].find(([, v]) => v === service);
    if (custom) return custom[0];
    const m = service.match(/^tcp\/(\d+)$/);
    if (m) {
      const n = `TCP-${m[1]}`;
      this.firewall.services.set(n, service);
      return n;
    }
    return service.toUpperCase();
  }

  // ------------------------------------------------------------ firewall: application control

  /** Function codes an application list lets through, or undefined if the firewall cannot see them. */
  fcAllowed(listName: string): number[] | undefined {
    if (this.firewall.exclude !== "none") return undefined;
    const list = this.firewall.appLists.get(listName);
    if (!list) return undefined;
    const allowed = ALL_FCS.filter((fc) => {
      const sig = MODBUS_SIGNATURES.find((s) => s.fc === fc)!.name;
      const entry = list.entries.find((e) => e.application.includes(sig) || e.application.includes(MODBUS_BASE));
      const action = entry ? entry.action : list.otherAction;
      return action === "pass" || action === "monitor";
    });
    return allowed.length === ALL_FCS.length ? undefined : allowed;
  }

  /** The application list for a function code list, created if needed. */
  appListFor(fcs: number[]): string {
    const sorted = uniq(fcs).sort((a, b) => a - b);
    const name = `modbus-fc-${sorted.join("-")}`;
    if (!this.firewall.appLists.has(name)) {
      const pass = MODBUS_SIGNATURES.filter((s) => sorted.includes(s.fc)).map((s) => s.name);
      this.firewall.appLists.set(name, {
        name,
        comment: `Modbus function codes ${sorted.join(", ")} only`,
        otherAction: "pass",
        entries: [
          { id: 1, application: pass, action: "pass" },
          { id: 2, application: [MODBUS_BASE], action: "block" },
        ],
      });
    }
    return name;
  }

  /** After an application list or the IPS setting changes, update the rules that use it. */
  refreshAppControl(): void {
    for (const c of this.net.conduits) for (const r of c.rules) if (r.appList) {
      const fc = this.fcAllowed(r.appList);
      if (fc) r.fc = fc;
      else delete r.fc;
    }
  }

  // ------------------------------------------------------------ firewall: policies

  /** Interfaces a rule sits between, worked out when the rule does not name them. */
  private sides(c: Conduit, r: Rule): { src: string[]; dst: string[] } {
    const side = (e: Endpoint, explicit?: string): string[] | undefined => {
      if (explicit) return [explicit];
      if (e.type === "zone") return [e.name];
      if (e.type === "host") {
        const h = this.net.host(e.name);
        return h && c.zones.includes(h.zone) ? [h.zone] : [c.zones[0]];
      }
      return undefined;
    };
    let src = side(r.src, r.srcintf);
    let dst = side(r.dst, r.dstintf);
    if (!src && dst) src = c.zones.filter((z) => z !== dst![0]);
    if (!dst && src) dst = c.zones.filter((z) => z !== src![0]);
    if (!src || !dst) {
      src = [...c.zones];
      dst = [...c.zones];
    }
    return { src, dst };
  }

  /** Every policy, in the order its rules appear. */
  policies(): PolicyView[] {
    const byId = new Map<number, PolicyView>();
    for (const c of this.net.conduits) {
      c.rules.forEach((r, i) => {
        if (r.id === undefined) r.id = this.net.nextRuleId++;
        let p = byId.get(r.id);
        if (!p) {
          p = { id: r.id, name: r.name ?? "", srcintf: [], dstintf: [], srcaddr: [], dstaddr: [], service: [], action: r.action === "allow" ? "accept" : "deny", status: r.disabled ? "disable" : "enable", utm: !!r.appList, appList: r.appList, logtraffic: "all", rules: [] };
          byId.set(r.id, p);
        }
        const s = this.sides(c, r);
        p.srcintf = uniq([...p.srcintf, ...s.src]);
        p.dstintf = uniq([...p.dstintf, ...s.dst]);
        p.srcaddr = uniq([...p.srcaddr, r.src.type === "host" ? r.src.name : "all"]);
        p.dstaddr = uniq([...p.dstaddr, r.dst.type === "host" ? r.dst.name : "all"]);
        p.service = uniq([...p.service, this.serviceName(r.service)]);
        p.rules.push({ conduit: c, rule: r, index: i });
      });
    }
    return [...byId.values()];
  }

  policy(id: number): PolicyView | undefined {
    return this.policies().find((p) => p.id === id);
  }

  newPolicyDraft(id: number): PolicyDraft {
    return { id, name: "", srcintf: [], dstintf: [], srcaddr: [], dstaddr: [], service: [], action: "deny", status: "enable", utm: false, logtraffic: "utm" };
  }

  /** A free policy ID for "edit 0". */
  freePolicyId(): number {
    const used = new Set(this.policies().map((p) => p.id));
    let id = Math.max(1, this.net.nextRuleId);
    while (used.has(id)) id++;
    return id;
  }

  /** Save a policy: replace the rules of that ID with the ones it describes. Returns notes for the learner. */
  commitPolicy(d: PolicyDraft): string[] {
    const notes: string[] = [];
    for (const f of ["srcintf", "dstintf", "srcaddr", "dstaddr"] as const) if (!d[f].length) throw new UserError(`Attribute '${f}' MUST be set.`);
    if (!d.service.length) throw new UserError("Attribute 'service' MUST be set.");
    const ifaces = new Set(this.interfaces().map((i) => i.name));
    for (const i of [...d.srcintf, ...d.dstintf]) if (!ifaces.has(i)) throw new UserError(`entry not found in datasource\nvalue parse error before '${i}'`);
    const resolve = (a: string) => {
      const r = this.resolveAddress(a);
      if (!r) throw new UserError(`entry not found in datasource\nvalue parse error before '${a}'`);
      return r;
    };
    const services = d.service.map((s) => {
      const v = this.resolveService(s);
      if (!v) throw new UserError(`entry not found in datasource\nvalue parse error before '${s}'`);
      return v;
    });
    if (d.utm && d.appList && !this.firewall.appLists.has(d.appList)) throw new UserError(`entry not found in datasource\nvalue parse error before '${d.appList}'`);
    const appList = d.utm ? d.appList : undefined;
    const fc = appList ? this.fcAllowed(appList) : undefined;
    if (appList && this.firewall.exclude !== "none" && services.includes("modbus")) notes.push("OT signatures are excluded on this FortiGate, so the application list cannot see Modbus function codes. Enable them with: config ips global, set exclude-signatures none, end.");

    // Where the old rules were, so an edit keeps its place.
    const old = this.policy(d.id);
    const oldPos = new Map<Conduit, number>();
    if (old) for (const x of old.rules) if (!oldPos.has(x.conduit)) oldPos.set(x.conduit, x.conduit.rules.indexOf(x.rule));
    const hits = new Map<string, number>();
    if (old) for (const x of old.rules) hits.set(`${x.conduit.name}|${JSON.stringify(x.rule.src)}|${JSON.stringify(x.rule.dst)}|${x.rule.service}`, x.rule.hits);
    for (const c of this.net.conduits) c.rules = c.rules.filter((r) => r.id !== d.id);

    const added = new Map<Conduit, Rule[]>();
    for (const si of d.srcintf)
      for (const di of d.dstintf) {
        if (si === di) continue;
        let c = this.net.conduitBetween(si, di);
        if (!c) {
          let name = `${si}-${di}`.slice(0, 24).replace(/-$/, "");
          if (this.net.conduit(name) || this.net.zone(name) || this.net.host(name)) name = `policy-${d.id}`;
          c = this.net.createConduit(name, si, di);
          notes.push(`ZoneSim shows the traffic between ${si} and ${di} as conduit ${c.name}.`);
        }
        for (const sa of d.srcaddr)
          for (const da of d.dstaddr)
            services.forEach((svc) => {
              const s = resolve(sa);
              const t = resolve(da);
              if (s !== "all" && s.zone !== si) notes.push(`${s.name} is in zone ${s.zone}, not behind interface ${si}, so this policy will not match its traffic.`);
              if (t !== "all" && t.zone !== di) notes.push(`${t.name} is in zone ${t.zone}, not behind interface ${di}, so this policy will not match its traffic.`);
              const rule: Rule = {
                action: d.action === "accept" ? "allow" : "deny",
                src: s === "all" ? { type: "zone", name: si } : { type: "host", name: s.name },
                dst: t === "all" ? { type: "zone", name: di } : { type: "host", name: t.name },
                service: svc,
                hits: 0,
                id: d.id,
                srcintf: si,
                dstintf: di,
                ...(d.name ? { name: d.name } : {}),
                ...(appList ? { appList } : {}),
                ...(fc && svc === "modbus" ? { fc } : {}),
                ...(d.status === "disable" ? { disabled: true } : {}),
              };
              rule.hits = hits.get(`${c!.name}|${JSON.stringify(rule.src)}|${JSON.stringify(rule.dst)}|${rule.service}`) ?? 0;
              added.set(c!, [...(added.get(c!) ?? []), rule]);
            });
      }
    for (const [c, rules] of added) {
      const at = oldPos.get(c);
      if (at === undefined || at < 0) c.rules.push(...rules);
      else c.rules.splice(Math.min(at, c.rules.length), 0, ...rules);
    }
    this.net.nextRuleId = Math.max(this.net.nextRuleId, d.id + 1);
    return uniq(notes);
  }

  deletePolicy(id: number): boolean {
    let found = false;
    for (const c of this.net.conduits) {
      const before = c.rules.length;
      c.rules = c.rules.filter((r) => r.id !== id);
      if (c.rules.length !== before) found = true;
    }
    return found;
  }

  /** Move a policy before or after another. Only the order between the same interfaces matters. */
  movePolicy(id: number, where: "before" | "after", other: number): void {
    const p = this.policy(id);
    const q = this.policy(other);
    if (!p || !q) throw new UserError("entry not found in datasource");
    for (const c of this.net.conduits) {
      const mine = c.rules.filter((r) => r.id === id);
      const theirs = c.rules.findIndex((r) => r.id === other);
      if (!mine.length || theirs < 0) continue;
      const rest = c.rules.filter((r) => r.id !== id);
      let at = rest.findIndex((r) => r.id === other);
      if (where === "after") {
        while (at < rest.length && rest[at]?.id === other) at++;
      }
      rest.splice(at, 0, ...mine);
      c.rules = rest;
    }
  }
}

/** A VLAN name as a zone name: lower case, dashes for spaces. */
export function zoneName(text: string): string {
  const n = text.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "");
  if (!/^[a-z][a-z0-9-]{0,23}$/.test(n)) throw new UserError(`"${text}" cannot be a zone name. Use letters, digits and dashes, starting with a letter, at most 24 characters.`);
  return n;
}

export { portName };
