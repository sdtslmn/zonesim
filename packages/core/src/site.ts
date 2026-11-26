// Site files. A site describes one plant: its hosts and network as found,
// the process and its parameters, the controllers and their Modbus maps,
// the traffic it generates, the data flows it needs and what the IDS
// considers normal. A site can extend another one and change only a few
// values, including renaming hosts.

import { parse } from "yaml";
import { PROCESS_MODELS } from "./process/index.js";
import { TABLES, tableFor, type PointTable } from "./modbus.js";

export const SITE_SCHEMA = "zonesim-site/1";

export const LEVELS = [5, 4, 3.5, 3, 2, 1, 0];
export const SITE_SERVICES = ["ssh", "http", "https", "modbus", "rdp"];
export const HOST_KINDS = ["external", "it", "dmz", "ot"] as const;
export type HostKind = (typeof HOST_KINDS)[number];

export interface SitePoint {
  addr: number;
  tag: string;
  signal: string;
  description: string;
  units?: string;
}

export interface SiteDevice {
  title: string;
  vendor: string;
  product: string;
  revision: string;
  points: Record<PointTable, SitePoint[]>;
}

export interface SiteHost {
  name: string;
  role?: string;
  ip: string;
  level: number;
  kind: HostKind;
  services: string[];
  os: string;
  user: string;
  description: string;
  /** Multi-factor authentication for remote logins to this host. */
  mfa?: boolean;
}

export interface SiteZone {
  name: string;
  description?: string;
  sl?: number;
  hosts: string[];
  /** VLAN on the plant switches. */
  vlan?: number;
  /** A firewall port instead of a VLAN, for the internet or a WAN link. */
  port?: string;
}

export const FIREWALL_VENDORS = ["fortinet"] as const;
export const SWITCH_VENDORS = ["hirschmann", "cisco"] as const;
export type FirewallVendor = (typeof FIREWALL_VENDORS)[number];
export type SwitchVendor = (typeof SWITCH_VENDORS)[number];

export interface SiteFirewall {
  name: string;
  vendor: FirewallVendor;
  model: string;
  firmware: string;
  hostname: string;
  ip: string;
  /** OT application signatures loaded (FortiGate: config ips global, exclude-signatures none). */
  otSignatures: boolean;
}

export interface SiteSwitch {
  name: string;
  vendor: SwitchVendor;
  model: string;
  firmware: string;
  hostname: string;
  ip: string;
  /** Ports in order; host is empty for a spare port. */
  ports: { id: string; host?: string }[];
}

export interface SiteNetwork {
  firewall: SiteFirewall;
  switches: SiteSwitch[];
}

export interface SiteConduit {
  name: string;
  zones: [string, string];
  rules: string[];
}

/** When a poll runs or a flow is needed: always (left out), in normal operation, or while the backup centre has taken over. */
export type SiteMode = "normal" | "takeover";
export const SITE_MODES: SiteMode[] = ["normal", "takeover"];

export interface SitePoll {
  from: string;
  to: string;
  service: string;
  fc?: number[];
  every: number;
  when?: SiteMode;
}

export interface SiteHop {
  from: string;
  to: string;
  service: string;
  fc?: number[];
}

export interface SiteFlow {
  id: string;
  title: string;
  why: string;
  paths: SiteHop[][];
  when?: SiteMode;
}

/**
 * A main control centre with a passive backup. The backup sends nothing to the
 * plant until the main centre is lost; then the hosts in lost stop, and the
 * backup takes over the HMI role and its own polls and flows (when: takeover).
 */
export interface SiteStandby {
  /** What the main centre is called, e.g. OCC. */
  centre: string;
  /** What the backup centre is called, e.g. BOCC. */
  backupName: string;
  /** The backup centre's control system host. */
  backup: string;
  /** Hosts that stop when the main centre is lost. */
  lost: string[];
}

export interface Site {
  id: string;
  name: string;
  description: string;
  /** The chain of sites this one extends, nearest first. */
  extends: string[];
  process: { model: string; tags: Record<string, string>; params: Record<string, number> };
  hosts: SiteHost[];
  zones: SiteZone[];
  conduits: SiteConduit[];
  devices: Record<string, SiteDevice>;
  /** Firewall and switches. Generated when the site file has none. */
  network: SiteNetwork;
  hmi?: { host: string; device: string; timeout: number };
  polling: SitePoll[];
  flows: SiteFlow[];
  standby?: SiteStandby;
  ids: { writers: Record<string, string[]>; safety: string[]; identify: string[] };
}

export interface SiteLoadResult {
  site?: Site;
  errors: string[];
  warnings: string[];
}

export const NAME_RE = /^[a-z][a-z0-9-]{0,23}$/;
const ID_RE = /^[a-z][a-z0-9-]{1,40}$/;
const IP_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

// ---------------------------------------------------------------- extends and rename

function mergeNamed(base: unknown, over: unknown, key: string): unknown[] {
  const out = Array.isArray(base) ? clone(base) : [];
  if (!Array.isArray(over)) return out;
  for (const item of over) {
    if (!isObj(item)) {
      out.push(item);
      continue;
    }
    const i = out.findIndex((x) => isObj(x) && x[key] === item[key]);
    if (item.remove === true) {
      if (i >= 0) out.splice(i, 1);
      continue;
    }
    if (i >= 0) out[i] = { ...(out[i] as Raw), ...item };
    else out.push(item);
  }
  return out;
}

function mergeDevices(base: unknown, over: unknown): Raw {
  const out: Raw = isObj(base) ? clone(base) : {};
  if (!isObj(over)) return out;
  for (const [host, dev] of Object.entries(over)) {
    if (dev === null || (isObj(dev) && dev.remove === true)) {
      delete out[host];
      continue;
    }
    if (!isObj(dev)) {
      out[host] = dev;
      continue;
    }
    const prev = isObj(out[host]) ? (out[host] as Raw) : {};
    out[host] = { ...prev, ...dev, points: { ...(isObj(prev.points) ? prev.points : {}), ...(isObj(dev.points) ? dev.points : {}) } };
  }
  return out;
}

function mergeSite(base: Raw, over: Raw): Raw {
  const out = clone(base);
  for (const [key, value] of Object.entries(over)) {
    if (key === "extends" || key === "rename" || key === "schema") continue;
    switch (key) {
      case "hosts":
      case "zones":
      case "conduits":
        out[key] = mergeNamed(base[key], value, "name");
        break;
      case "flows":
        out[key] = mergeNamed(base[key], value, "id");
        break;
      case "standby":
        out.standby = isObj(base.standby) && isObj(value) ? { ...base.standby, ...value } : clone(value);
        break;
      case "devices":
        out[key] = mergeDevices(base[key], value);
        break;
      case "process": {
        const b = isObj(base.process) ? base.process : {};
        const v = isObj(value) ? value : {};
        out.process = { ...b, ...v, tags: { ...(isObj(b.tags) ? b.tags : {}), ...(isObj(v.tags) ? v.tags : {}) }, params: { ...(isObj(b.params) ? b.params : {}), ...(isObj(v.params) ? v.params : {}) } };
        break;
      }
      case "ids": {
        const b = isObj(base.ids) ? base.ids : {};
        const v = isObj(value) ? value : {};
        out.ids = { ...b, ...v, writers: { ...(isObj(b.writers) ? b.writers : {}), ...(isObj(v.writers) ? v.writers : {}) } };
        break;
      }
      case "hmi":
        out.hmi = { ...(isObj(base.hmi) ? base.hmi : {}), ...(isObj(value) ? value : {}) };
        break;
      case "network": {
        const b = isObj(base.network) ? base.network : {};
        const v = isObj(value) ? value : {};
        out.network = {
          ...b,
          ...v,
          firewall: { ...(isObj(b.firewall) ? b.firewall : {}), ...(isObj(v.firewall) ? v.firewall : {}) },
          switches: v.switches === undefined ? clone(b.switches) : mergeNamed(b.switches, v.switches, "name"),
        };
        // A switch that changes brand without naming a model gets that brand's default model.
        if (Array.isArray(v.switches) && Array.isArray(b.switches)) {
          for (const sw of v.switches) {
            if (!isObj(sw) || sw.vendor === undefined) continue;
            const before = b.switches.find((x) => isObj(x) && x.name === sw.name) as Raw | undefined;
            const merged = (out.network as Raw).switches as Raw[];
            const m = merged.find((x) => isObj(x) && x.name === sw.name);
            if (m && before && before.vendor !== sw.vendor) {
              if (sw.model === undefined) delete m.model;
              if (sw.firmware === undefined) delete m.firmware;
            }
          }
        }
        break;
      }
      default:
        out[key] = clone(value);
    }
  }
  // A removed host frees its switch port.
  const removed = new Set((Array.isArray(over.hosts) ? over.hosts : []).filter((h): h is Raw => isObj(h) && h.remove === true).map((h) => h.name));
  if (removed.size && isObj(out.network) && Array.isArray(out.network.switches)) {
    for (const sw of out.network.switches) if (isObj(sw) && isObj(sw.ports)) for (const [k, v] of Object.entries(sw.ports)) if (removed.has(v)) sw.ports[k] = null;
  }
  return out;
}

/** Rename hosts and zones everywhere they are referenced. */
export function renameInSite(site: Raw, map: Record<string, string>, errors: string[]): Raw {
  const out = clone(site);
  const hosts = Array.isArray(out.hosts) ? (out.hosts as Raw[]) : [];
  const zones = Array.isArray(out.zones) ? (out.zones as Raw[]) : [];
  const known = new Set([...hosts.map((h) => h.name), ...zones.map((z) => z.name)]);
  for (const [from, to] of Object.entries(map)) {
    if (!known.has(from)) errors.push(`rename: "${from}" is not a host or zone in the site being extended`);
    if (typeof to !== "string" || !NAME_RE.test(to)) errors.push(`rename: "${String(to)}" is not a valid name (lower-case letters, digits and dashes, starting with a letter)`);
  }
  const r = (n: unknown) => (typeof n === "string" && Object.prototype.hasOwnProperty.call(map, n) ? map[n] : n);
  const rWords = (s: unknown) => (typeof s === "string" ? s.split(/(\s+)/).map((w) => (/\s/.test(w) ? w : r(w))).join("") : s);
  const rHop = (h: unknown) => (isObj(h) ? { ...h, from: r(h.from), to: r(h.to) } : h);
  for (const h of hosts) h.name = r(h.name);
  for (const z of zones) {
    z.name = r(z.name);
    if (Array.isArray(z.hosts)) z.hosts = z.hosts.map(r);
  }
  if (Array.isArray(out.conduits)) {
    for (const c of out.conduits as Raw[]) {
      if (Array.isArray(c.zones)) c.zones = c.zones.map(r);
      if (Array.isArray(c.rules)) c.rules = c.rules.map(rWords);
    }
  }
  if (isObj(out.devices)) out.devices = Object.fromEntries(Object.entries(out.devices).map(([k, v]) => [r(k) as string, v]));
  if (isObj(out.hmi)) out.hmi = { ...out.hmi, host: r(out.hmi.host), device: r(out.hmi.device) };
  if (isObj(out.standby)) out.standby = { ...out.standby, backup: r(out.standby.backup), ...(Array.isArray(out.standby.lost) ? { lost: out.standby.lost.map(r) } : {}) };
  if (isObj(out.network) && Array.isArray(out.network.switches)) {
    for (const sw of out.network.switches as Raw[]) if (isObj(sw.ports)) sw.ports = Object.fromEntries(Object.entries(sw.ports).map(([k, v]) => [k, r(v)]));
  }
  if (Array.isArray(out.polling)) out.polling = (out.polling as unknown[]).map(rHop);
  if (Array.isArray(out.flows)) {
    out.flows = (out.flows as Raw[]).map((f) => ({
      ...rHop(f) as Raw,
      ...(Array.isArray(f.paths) ? { paths: f.paths.map((p) => (Array.isArray(p) ? p.map(rHop) : p)) } : {}),
      ...(typeof f.title === "string" ? { title: rWords(f.title) } : {}),
    }));
  }
  if (isObj(out.ids)) {
    const ids = out.ids;
    if (isObj(ids.writers)) ids.writers = Object.fromEntries(Object.entries(ids.writers).map(([k, v]) => [r(k) as string, Array.isArray(v) ? v.map(r) : v]));
    if (Array.isArray(ids.safety)) ids.safety = ids.safety.map(r);
    if (Array.isArray(ids.identify)) ids.identify = ids.identify.map(r);
  }
  return out;
}

/** Turn a site file (YAML text or object) into a full raw site, applying extends and rename. */
function resolveRaw(input: Raw, builtins: Record<string, Raw>, errors: string[], depth = 0): { raw: Raw; chain: string[] } {
  if (typeof input.extends !== "string") return { raw: input, chain: [] };
  if (depth > 4) {
    errors.push("extends goes more than 5 levels deep");
    return { raw: input, chain: [] };
  }
  const baseRaw = builtins[input.extends];
  if (!baseRaw) {
    errors.push(`extends: there is no built-in site "${input.extends}". Built-in sites: ${Object.keys(builtins).join(", ") || "none"}`);
    return { raw: input, chain: [] };
  }
  const base = resolveRaw(baseRaw, builtins, errors, depth + 1);
  let b = base.raw;
  if (input.rename !== undefined) {
    if (!isObj(input.rename)) errors.push("rename must be a map of old name: new name");
    else b = renameInSite(b, input.rename as Record<string, string>, errors);
  }
  return { raw: mergeSite(b, input), chain: [input.extends, ...base.chain] };
}

// ---------------------------------------------------------------- validation

function describeHop(h: SiteHop): string {
  if (h.service === "modbus") {
    const writes = (h.fc ?? []).some((f) => [5, 6, 15, 16].includes(f));
    const engineering = (h.fc ?? []).includes(43) && writes;
    return engineering ? "Modbus engineering access" : writes ? "Modbus read and write" : "Modbus read";
  }
  return { https: "HTTPS", http: "HTTP", rdp: "remote desktop", ssh: "SSH" }[h.service] ?? h.service;
}

export function flowTitle(paths: SiteHop[][]): string {
  const p = paths[0] ?? [];
  if (!p.length) return "";
  const first = p[0];
  const last = p[p.length - 1];
  return `${first.from} → ${last.to} ${describeHop(last)}`;
}

function defaultKind(level: number): HostKind {
  return level >= 5 ? "external" : level >= 4 ? "it" : level >= 3.5 ? "dmz" : "ot";
}

class Checker {
  errors: string[] = [];
  warnings: string[] = [];

  str(v: unknown, where: string, required = true): string {
    if (v === undefined || v === null || v === "") {
      if (required) this.errors.push(`${where} is required`);
      return "";
    }
    if (typeof v !== "string" && typeof v !== "number") {
      this.errors.push(`${where} must be text`);
      return "";
    }
    return String(v);
  }

  num(v: unknown, where: string): number {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      this.errors.push(`${where} must be a number`);
      return NaN;
    }
    return v;
  }

  list(v: unknown, where: string, required = true): unknown[] {
    if (v === undefined || v === null) {
      if (required) this.errors.push(`${where} is required`);
      return [];
    }
    if (!Array.isArray(v)) {
      this.errors.push(`${where} must be a list`);
      return [];
    }
    return v;
  }

  fcList(v: unknown, where: string): number[] | undefined {
    if (v === undefined) return undefined;
    const l = this.list(v, where);
    const out: number[] = [];
    for (const x of l) {
      if (!Number.isInteger(x) || (x as number) < 1 || (x as number) > 127) this.errors.push(`${where}: function code ${String(x)} must be a whole number from 1 to 127`);
      else out.push(x as number);
    }
    return out;
  }
}

function normalize(raw: Raw, chain: string[], c: Checker): Site | undefined {
  if (raw.schema !== undefined && raw.schema !== SITE_SCHEMA) c.errors.push(`schema must be "${SITE_SCHEMA}"`);
  const id = c.str(raw.id, "id");
  if (id && !ID_RE.test(id)) c.errors.push(`id "${id}" must be lower-case letters, digits and dashes, starting with a letter`);
  const name = c.str(raw.name, "name");

  // process
  const proc = isObj(raw.process) ? raw.process : undefined;
  if (!proc) c.errors.push("process is required");
  const modelName = c.str(proc?.model, "process.model");
  const model = PROCESS_MODELS[modelName];
  if (modelName && !model) c.errors.push(`process.model "${modelName}" is unknown. Available: ${Object.keys(PROCESS_MODELS).join(", ")}`);
  const params: Record<string, number> = {};
  const tags: Record<string, string> = { ...(model?.tags ?? {}) };
  if (model) {
    const given = isObj(proc?.params) ? proc!.params : {};
    for (const k of Object.keys(given)) if (!model.params.some((p) => p.name === k)) c.errors.push(`process.params.${k} is not a parameter of the ${model.model} model`);
    for (const p of model.params) {
      const v = given[p.name];
      if (v === undefined) params[p.name] = p.default;
      else {
        const n = c.num(v, `process.params.${p.name}`);
        if (Number.isFinite(n) && (n < p.min || n > p.max)) c.errors.push(`process.params.${p.name} must be between ${p.min} and ${p.max}`);
        params[p.name] = n;
      }
    }
    for (const e of model.check(params)) c.errors.push(`process.params: ${e}`);
    if (isObj(proc?.tags)) for (const [k, v] of Object.entries(proc!.tags)) tags[k] = c.str(v, `process.tags.${k}`);
  }

  // hosts
  const hosts: SiteHost[] = [];
  const names = new Set<string>();
  const ips = new Set<string>();
  const roles = new Set<string>();
  c.list(raw.hosts, "hosts").forEach((h, i) => {
    const where = `hosts[${i + 1}]`;
    if (!isObj(h)) return c.errors.push(`${where} must be a map`);
    const hn = c.str(h.name, `${where}.name`);
    const w = hn ? `host ${hn}` : where;
    if (hn && !NAME_RE.test(hn)) c.errors.push(`${w}: names use lower-case letters, digits and dashes, start with a letter, at most 24 characters`);
    if (names.has(hn)) c.errors.push(`${w}: the name is used twice`);
    names.add(hn);
    const ip = c.str(h.ip, `${w}.ip`);
    if (ip && !IP_RE.test(ip)) c.errors.push(`${w}: "${ip}" is not an IPv4 address`);
    if (ips.has(ip)) c.errors.push(`${w}: IP address ${ip} is used twice`);
    ips.add(ip);
    const level = c.num(h.level, `${w}.level`);
    if (Number.isFinite(level) && !LEVELS.includes(level)) c.errors.push(`${w}: level must be one of ${LEVELS.join(", ")} (Purdue levels; 3.5 is the DMZ)`);
    const role = h.role === undefined ? undefined : c.str(h.role, `${w}.role`);
    if (role) {
      if (!/^[a-z][a-z0-9-]*$/.test(role)) c.errors.push(`${w}: role "${role}" must be lower-case letters, digits and dashes`);
      if (roles.has(role)) c.errors.push(`${w}: role "${role}" is used by two hosts; each role names one host`);
      roles.add(role);
    }
    const kind = (h.kind === undefined ? defaultKind(level) : c.str(h.kind, `${w}.kind`)) as HostKind;
    if (!HOST_KINDS.includes(kind)) c.errors.push(`${w}: kind must be one of ${HOST_KINDS.join(", ")}`);
    const services = c.list(h.services, `${w}.services`, false).map((s) => c.str(s, `${w}.services`));
    for (const s of services) if (s && !SITE_SERVICES.includes(s)) c.errors.push(`${w}: unknown service "${s}". Use ${SITE_SERVICES.join(", ")}`);
    hosts.push({ name: hn, role, ip, level, kind, services, os: c.str(h.os, `${w}.os`, false), user: c.str(h.user, `${w}.user`, false), description: c.str(h.description, `${w}.description`, false), ...(h.mfa === true ? { mfa: true } : {}) });
    if (h.mfa !== undefined && typeof h.mfa !== "boolean") c.errors.push(`${w}.mfa must be true or false`);
  });
  if (!hosts.length && Array.isArray(raw.hosts)) c.errors.push("hosts must list at least one host");
  const host = (n: string) => hosts.find((h) => h.name === n);

  // zones
  const zones: SiteZone[] = [];
  const placed = new Map<string, string>();
  c.list(raw.zones, "zones").forEach((z, i) => {
    const where = `zones[${i + 1}]`;
    if (!isObj(z)) return c.errors.push(`${where} must be a map`);
    const zn = c.str(z.name, `${where}.name`);
    const w = zn ? `zone ${zn}` : where;
    if (zn && !NAME_RE.test(zn)) c.errors.push(`${w}: names use lower-case letters, digits and dashes, start with a letter, at most 24 characters`);
    if (zones.some((x) => x.name === zn)) c.errors.push(`${w}: the name is used twice`);
    if (names.has(zn)) c.errors.push(`${w}: a host has the same name; zone and host names must differ`);
    const sl = z.sl === undefined ? undefined : c.num(z.sl, `${w}.sl`);
    if (sl !== undefined && ![1, 2, 3, 4].includes(sl)) c.errors.push(`${w}: sl (target security level) must be 1, 2, 3 or 4`);
    const members = c.list(z.hosts, `${w}.hosts`, false).map((h) => c.str(h, `${w}.hosts`));
    for (const m of members) {
      if (!host(m)) c.errors.push(`${w}: unknown host "${m}"`);
      else if (placed.has(m)) c.errors.push(`${w}: host ${m} is already in zone ${placed.get(m)}; a host is in exactly one zone`);
      else placed.set(m, zn);
    }
    const vlan = z.vlan === undefined ? undefined : c.num(z.vlan, `${w}.vlan`);
    if (vlan !== undefined && (!Number.isInteger(vlan) || vlan < 1 || vlan > 4042)) c.errors.push(`${w}: vlan must be a whole number from 1 to 4042`);
    if (vlan !== undefined && zones.some((x) => x.vlan === vlan)) c.errors.push(`${w}: VLAN ${vlan} is already used by zone ${zones.find((x) => x.vlan === vlan)!.name}`);
    const port = z.port === undefined ? undefined : c.str(z.port, `${w}.port`);
    if (port !== undefined && vlan !== undefined) c.errors.push(`${w}: give a zone either a vlan or a firewall port, not both`);
    zones.push({ name: zn, description: z.description === undefined ? undefined : c.str(z.description, `${w}.description`), sl, hosts: members, ...(vlan !== undefined ? { vlan } : {}), ...(port ? { port } : {}) });
  });
  // Zones of outside hosts are firewall ports; the others are VLANs. The first VLAN zone without a number is VLAN 1, as found on most plants.
  let wan = 1;
  for (const z of zones) {
    if (z.vlan !== undefined || z.port) continue;
    const members = z.hosts.map(host).filter((h): h is SiteHost => !!h);
    if (members.length && members.every((h) => h.kind === "external")) {
      while (zones.some((x) => x.port === `wan${wan}`)) wan++;
      z.port = `wan${wan++}`;
    }
  }
  for (const z of zones) {
    if (z.vlan !== undefined || z.port) continue;
    if (!zones.some((x) => x.vlan === 1)) z.vlan = 1;
    else for (let v = 10; v < 4090; v += 10) if (!zones.some((x) => x.vlan === v)) {
      z.vlan = v;
      break;
    }
  }
  for (const h of hosts) if (h.name && !placed.has(h.name)) c.errors.push(`host ${h.name} is not in any zone`);

  // conduits
  const conduits: SiteConduit[] = [];
  c.list(raw.conduits, "conduits", false).forEach((cd, i) => {
    const where = `conduits[${i + 1}]`;
    if (!isObj(cd)) return c.errors.push(`${where} must be a map`);
    const cn = c.str(cd.name, `${where}.name`);
    const w = cn ? `conduit ${cn}` : where;
    if (cn && !NAME_RE.test(cn)) c.errors.push(`${w}: names use lower-case letters, digits and dashes, start with a letter`);
    if (conduits.some((x) => x.name === cn) || names.has(cn) || zones.some((z) => z.name === cn)) c.errors.push(`${w}: the name is already used by a host, zone or conduit`);
    const zs = c.list(cd.zones, `${w}.zones`).map((z) => c.str(z, `${w}.zones`));
    if (zs.length !== 2) c.errors.push(`${w}: zones must name exactly two zones`);
    for (const z of zs) if (z && !zones.some((x) => x.name === z)) c.errors.push(`${w}: unknown zone "${z}"`);
    if (zs.length === 2 && zs[0] === zs[1]) c.errors.push(`${w}: a conduit connects two different zones`);
    const dup = conduits.find((x) => zs.length === 2 && ((x.zones[0] === zs[0] && x.zones[1] === zs[1]) || (x.zones[0] === zs[1] && x.zones[1] === zs[0])));
    if (dup) c.errors.push(`${w}: zones ${zs[0]} and ${zs[1]} are already connected by conduit ${dup.name}`);
    const rules = c.list(cd.rules, `${w}.rules`, false).map((r) => c.str(r, `${w}.rules`));
    conduits.push({ name: cn, zones: [zs[0] ?? "", zs[1] ?? ""], rules });
  });

  // devices
  const devices: Record<string, SiteDevice> = {};
  const devRaw = raw.devices === undefined ? {} : raw.devices;
  if (!isObj(devRaw)) c.errors.push("devices must be a map of host name: device");
  else {
    for (const [hn, d] of Object.entries(devRaw)) {
      const w = `devices.${hn}`;
      const h = host(hn);
      if (!h) c.errors.push(`${w}: there is no host "${hn}"`);
      else if (!h.services.includes("modbus")) c.errors.push(`${w}: host ${hn} must offer the modbus service`);
      if (!isObj(d)) {
        c.errors.push(`${w} must be a map`);
        continue;
      }
      const points = {} as Record<PointTable, SitePoint[]>;
      const pr = isObj(d.points) ? d.points : {};
      if (!isObj(d.points)) c.errors.push(`${w}.points is required`);
      for (const k of Object.keys(pr)) if (!(TABLES as string[]).includes(k)) c.errors.push(`${w}.points.${k}: tables are coil, di, ir and hr`);
      for (const t of TABLES) {
        const list: SitePoint[] = [];
        c.list(pr[t], `${w}.points.${t}`, false).forEach((p, i) => {
          const pw = `${w}.points.${t}[${i + 1}]`;
          if (!isObj(p)) return c.errors.push(`${pw} must be a map`);
          const addr = c.num(p.addr, `${pw}.addr`);
          if (Number.isFinite(addr) && (!Number.isInteger(addr) || addr < 0 || addr > 65535)) c.errors.push(`${pw}.addr must be a whole number from 0 to 65535`);
          if (list.some((x) => x.addr === addr)) c.errors.push(`${pw}: address ${addr} is used twice in ${t}`);
          const signal = c.str(p.signal, `${pw}.signal`);
          const spec = model?.signals.find((s) => s.name === signal);
          if (model && signal && !spec) c.errors.push(`${pw}: "${signal}" is not a signal of the ${model.model} model`);
          if (spec && tableFor(spec.type, spec.writable) !== t) c.errors.push(`${pw}: signal ${signal} is ${spec.writable ? "writable" : "read-only"} ${spec.type === "bool" ? "on/off" : "number"}, so it belongs in ${tableFor(spec.type, spec.writable)}, not ${t}`);
          list.push({ addr, tag: c.str(p.tag, `${pw}.tag`), signal, description: c.str(p.description, `${pw}.description`, false) || spec?.description || "", units: p.units === undefined ? undefined : c.str(p.units, `${pw}.units`) });
        });
        list.sort((a, b) => a.addr - b.addr);
        if (list.length && list.some((p, i) => p.addr !== list[0].addr + i)) c.warnings.push(`${w}.points.${t}: addresses have gaps; reads across a gap get exception 2, like on a real device`);
        points[t] = list;
      }
      devices[hn] = {
        title: c.str(d.title, `${w}.title`, false) || h?.description || hn,
        vendor: c.str(d.vendor, `${w}.vendor`, false) || "Generic",
        product: c.str(d.product, `${w}.product`, false) || "Controller",
        revision: c.str(d.revision, `${w}.revision`, false) || "1.0",
        points,
      };
    }
  }
  for (const h of hosts) if (h.services.includes("modbus") && !devices[h.name]) c.warnings.push(`host ${h.name} offers modbus but has no device in devices, so it answers no Modbus requests`);

  // hmi
  let hmi: Site["hmi"];
  if (raw.hmi !== undefined) {
    if (!isObj(raw.hmi)) c.errors.push("hmi must be a map");
    else {
      const hh = c.str(raw.hmi.host, "hmi.host");
      const hd = c.str(raw.hmi.device, "hmi.device");
      if (hh && !host(hh)) c.errors.push(`hmi.host: there is no host "${hh}"`);
      if (hd && !devices[hd]) c.errors.push(`hmi.device: "${hd}" is not a device`);
      const timeout = raw.hmi.timeout === undefined ? 6 : c.num(raw.hmi.timeout, "hmi.timeout");
      hmi = { host: hh, device: hd, timeout };
    }
  }

  const checkHop = (h: unknown, where: string): SiteHop | undefined => {
    if (!isObj(h)) {
      c.errors.push(`${where} must be a map`);
      return undefined;
    }
    const from = c.str(h.from, `${where}.from`);
    const to = c.str(h.to, `${where}.to`);
    const service = c.str(h.service, `${where}.service`);
    if (from && !host(from)) c.errors.push(`${where}.from: there is no host "${from}"`);
    if (to && !host(to)) c.errors.push(`${where}.to: there is no host "${to}"`);
    if (service && !SITE_SERVICES.includes(service)) c.errors.push(`${where}.service: unknown service "${service}"`);
    const fc = c.fcList(h.fc, `${where}.fc`);
    if (fc && service !== "modbus") c.errors.push(`${where}: fc only applies to the modbus service`);
    return { from, to, service, ...(fc ? { fc } : {}) };
  };

  const modeOf = (v: unknown, where: string): SiteMode | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== "string" || !SITE_MODES.includes(v as SiteMode)) {
      c.errors.push(`${where}.when must be normal or takeover`);
      return undefined;
    }
    return v as SiteMode;
  };

  // polling
  const polling: SitePoll[] = [];
  c.list(raw.polling, "polling", false).forEach((p, i) => {
    const where = `polling[${i + 1}]`;
    const hop = checkHop(p, where);
    if (!hop || !isObj(p)) return;
    const every = c.num(p.every, `${where}.every`);
    if (Number.isFinite(every) && every < 1) c.errors.push(`${where}.every must be at least 1 second`);
    if (hop.service === "modbus" && !devices[hop.to]) c.errors.push(`${where}: ${hop.to} is not a Modbus device`);
    const when = modeOf(p.when, where);
    polling.push({ ...hop, every, ...(when ? { when } : {}) });
  });

  // flows
  const flows: SiteFlow[] = [];
  c.list(raw.flows, "flows", false).forEach((f, i) => {
    const where = `flows[${i + 1}]`;
    if (!isObj(f)) return c.errors.push(`${where} must be a map`);
    const fid = c.str(f.id, `${where}.id`);
    const w = fid ? `flow ${fid}` : where;
    if (flows.some((x) => x.id === fid)) c.errors.push(`${w}: the id is used twice`);
    let paths: SiteHop[][] = [];
    if (f.paths !== undefined) {
      paths = c.list(f.paths, `${w}.paths`).map((p, pi) => c.list(p, `${w}.paths[${pi + 1}]`).map((h, hi) => checkHop(h, `${w}.paths[${pi + 1}][${hi + 1}]`)).filter((h): h is SiteHop => !!h));
    } else {
      const hop = checkHop(f, w);
      if (hop) paths = [[hop]];
    }
    const when = modeOf(f.when, w);
    flows.push({ id: fid, title: typeof f.title === "string" ? f.title : flowTitle(paths), why: c.str(f.why, `${w}.why`, false), paths, ...(when ? { when } : {}) });
  });

  // standby: a passive backup centre
  let standby: SiteStandby | undefined;
  if (raw.standby !== undefined) {
    if (!isObj(raw.standby)) c.errors.push("standby must be a map");
    else {
      const sb = raw.standby;
      const backup = c.str(sb.backup, "standby.backup");
      if (backup && !host(backup)) c.errors.push(`standby.backup: there is no host "${backup}"`);
      const lost = c.list(sb.lost, "standby.lost").map((x) => c.str(x, "standby.lost"));
      for (const x of lost) if (!host(x)) c.errors.push(`standby.lost: there is no host "${x}"`);
      if (lost.includes(backup)) c.errors.push("standby.lost must not include the backup host");
      if (hmi && !lost.includes(hmi.host)) c.errors.push(`standby.lost must include the HMI host ${hmi.host}: the backup takes over its role`);
      standby = { centre: typeof sb.centre === "string" ? sb.centre : "main centre", backupName: typeof sb.backupName === "string" ? sb.backupName : "backup centre", backup, lost };
    }
  }
  for (const f of flows) if (f.when === "takeover" && !standby) c.errors.push(`flow ${f.id}: when: takeover needs a standby section`);
  for (const [i, p] of polling.entries()) if (p.when === "takeover" && !standby) c.errors.push(`polling[${i + 1}]: when: takeover needs a standby section`);

  // ids
  const idsRaw = isObj(raw.ids) ? raw.ids : {};
  const writers: Record<string, string[]> = {};
  if (isObj(idsRaw.writers)) {
    for (const [d, list] of Object.entries(idsRaw.writers)) {
      if (!devices[d]) c.errors.push(`ids.writers.${d}: "${d}" is not a device`);
      writers[d] = c.list(list, `ids.writers.${d}`).map((x) => c.str(x, `ids.writers.${d}`));
      for (const x of writers[d]) if (!host(x)) c.errors.push(`ids.writers.${d}: there is no host "${x}"`);
    }
  }
  const safety = c.list(idsRaw.safety, "ids.safety", false).map((x) => c.str(x, "ids.safety"));
  for (const x of safety) if (!devices[x]) c.errors.push(`ids.safety: "${x}" is not a device`);
  const identify = c.list(idsRaw.identify, "ids.identify", false).map((x) => c.str(x, "ids.identify"));
  for (const x of identify) if (!host(x)) c.errors.push(`ids.identify: there is no host "${x}"`);

  if (c.errors.length) return undefined;
  const network = normalizeNetwork(raw.network, hosts, zones, c);

  return {
    id,
    name,
    description: c.str(raw.description, "description", false).trim(),
    extends: chain,
    process: { model: modelName, tags, params },
    hosts,
    zones,
    conduits,
    devices,
    network,
    hmi,
    polling,
    flows,
    ...(standby ? { standby } : {}),
    ids: { writers, safety, identify },
  };
}

/** The model and firmware a switch gets when the site file does not say. */
export const SWITCH_DEFAULTS: Record<SwitchVendor, { model: string; firmware: string }> = {
  hirschmann: { model: "RSP35", firmware: "09.4.03" },
  cisco: { model: "IE-3400", firmware: "17.9.4" },
};

/** A copy of the site with one switch made by another vendor: same cabling, that vendor's port names and command line. */
export function withSwitchVendor(site: Site, name: string, vendor: SwitchVendor): Site {
  const sw = site.network.switches.find((s) => s.name === name);
  if (!sw || sw.vendor === vendor || !SWITCH_VENDORS.includes(vendor)) return site;
  const copy: Site = JSON.parse(JSON.stringify(site));
  const c = copy.network.switches.find((s) => s.name === name)!;
  c.vendor = vendor;
  c.model = SWITCH_DEFAULTS[vendor].model;
  c.firmware = SWITCH_DEFAULTS[vendor].firmware;
  c.ports = c.ports.map((p) => ({ ...p, id: normalizePort(vendor, p.id) ?? p.id }));
  return copy;
}

const PORT_RE: Record<SwitchVendor, RegExp> = { hirschmann: /^\d{1,2}\/\d{1,2}$/, cisco: /^Gi\d{1,2}\/\d{1,2}$/ };

/** Port names as each vendor writes them. */
export function portName(vendor: SwitchVendor, n: number): string {
  return vendor === "cisco" ? `Gi1/${n}` : `1/${n}`;
}

/** Turn "GigabitEthernet1/3", "gi1/3" or "1/3" into the vendor's short form. */
export function normalizePort(vendor: SwitchVendor, text: string): string | undefined {
  const m = text.trim().match(/^(?:gigabitethernet|gi|g)?\s*(\d{1,2})\/(\d{1,2})$/i);
  if (!m) return undefined;
  return vendor === "cisco" ? `Gi${m[1]}/${m[2]}` : `${m[1]}/${m[2]}`;
}

function normalizeNetwork(rawNet: unknown, hosts: SiteHost[], zones: SiteZone[], c: Checker): SiteNetwork {
  const n = isObj(rawNet) ? rawNet : {};
  const fwRaw = isObj(n.firewall) ? n.firewall : {};
  const vendor = (fwRaw.vendor ?? "fortinet") as FirewallVendor;
  if (!FIREWALL_VENDORS.includes(vendor)) c.errors.push(`network.firewall.vendor "${String(fwRaw.vendor)}" is not supported yet. Supported: ${FIREWALL_VENDORS.join(", ")}`);
  const fwName = typeof fwRaw.name === "string" ? fwRaw.name : "fw-1";
  const firewall: SiteFirewall = {
    name: fwName,
    vendor,
    model: typeof fwRaw.model === "string" ? fwRaw.model : "FortiGate Rugged 60F",
    firmware: typeof fwRaw.firmware === "string" ? fwRaw.firmware : "v7.4.4",
    hostname: typeof fwRaw.hostname === "string" ? fwRaw.hostname : "FGR60F-PLANT",
    ip: typeof fwRaw.ip === "string" ? fwRaw.ip : "192.168.250.1",
    otSignatures: fwRaw.otSignatures !== false,
  };
  if (!IP_RE.test(firewall.ip)) c.errors.push(`network.firewall.ip "${firewall.ip}" is not an IPv4 address`);
  const names = new Set(hosts.map((h) => h.name));
  if (names.has(firewall.name)) c.errors.push(`network.firewall: "${firewall.name}" is also a host name`);
  const onSwitch = new Map<string, string>();
  const switches: SiteSwitch[] = [];
  const external = new Set(zones.filter((z) => z.port).flatMap((z) => z.hosts));
  if (Array.isArray(n.switches)) {
    n.switches.forEach((sw, i) => {
      const where = `network.switches[${i + 1}]`;
      if (!isObj(sw)) return c.errors.push(`${where} must be a map`);
      const name = c.str(sw.name, `${where}.name`);
      const w = name ? `switch ${name}` : where;
      if (name && !NAME_RE.test(name)) c.errors.push(`${w}: names use lower-case letters, digits and dashes`);
      if (names.has(name) || name === firewall.name || switches.some((x) => x.name === name)) c.errors.push(`${w}: the name is already used`);
      const v = (sw.vendor ?? "hirschmann") as SwitchVendor;
      if (!SWITCH_VENDORS.includes(v)) c.errors.push(`${w}: vendor "${String(sw.vendor)}" is not supported yet. Supported: ${SWITCH_VENDORS.join(", ")}`);
      const ports: { id: string; host?: string }[] = [];
      if (isObj(sw.ports)) {
        for (const [pid, h] of Object.entries(sw.ports)) {
          const id = SWITCH_VENDORS.includes(v) ? normalizePort(v, pid) : pid;
          if (!id || !PORT_RE[v]?.test(id)) {
            c.errors.push(`${w}: port "${pid}" is not a ${v === "cisco" ? "Cisco port such as Gi1/3" : "Hirschmann port such as 1/3"}`);
            continue;
          }
          if (ports.some((x) => x.id === id)) c.errors.push(`${w}: port ${id} is listed twice`);
          if (h === null || h === undefined || h === "") {
            ports.push({ id });
            continue;
          }
          const hn = String(h);
          if (!names.has(hn)) c.errors.push(`${w}: port ${id}: unknown host "${hn}"`);
          else if (external.has(hn)) c.errors.push(`${w}: port ${id}: ${hn} is in a zone behind a firewall port, not on a plant switch`);
          else if (onSwitch.has(hn)) c.errors.push(`${w}: port ${id}: ${hn} is already on ${onSwitch.get(hn)}`);
          else onSwitch.set(hn, `${name} port ${id}`);
          ports.push({ id, host: hn });
        }
      } else if (sw.ports !== undefined) c.errors.push(`${w}: ports must be a map of port to host, for example "1/1": hmi-01`);
      switches.push({
        name,
        vendor: v,
        model: typeof sw.model === "string" ? sw.model : (SWITCH_DEFAULTS[v] ?? SWITCH_DEFAULTS.hirschmann).model,
        firmware: typeof sw.firmware === "string" ? sw.firmware : (SWITCH_DEFAULTS[v] ?? SWITCH_DEFAULTS.hirschmann).firmware,
        hostname: typeof sw.hostname === "string" ? sw.hostname : name.toUpperCase(),
        ip: typeof sw.ip === "string" ? sw.ip : `192.168.250.${11 + i}`,
        ports,
      });
    });
  }
  // Hosts not on any switch go onto the first one, or onto a generated switch.
  const loose = hosts.filter((h) => h.name && !external.has(h.name) && !onSwitch.has(h.name));
  if (loose.length) {
    let sw = switches[0];
    if (!sw) {
      sw = { name: "sw-1", vendor: "hirschmann", model: "RSP35", firmware: "09.4.03", hostname: "SW-1", ip: "192.168.250.11", ports: [] };
      switches.push(sw);
    }
    let k = sw.ports.length;
    for (const h of loose) sw.ports.push({ id: portName(sw.vendor, ++k), host: h.name });
    if (!isObj(rawNet)) for (let i = 0; i < 2; i++) sw.ports.push({ id: portName(sw.vendor, ++k) });
  }
  return { firewall, switches };
}

/** Parse YAML text into an object, with readable errors. */
export function parseSiteText(text: string, errors: string[]): Raw | undefined {
  try {
    const v = parse(text) as unknown;
    if (!isObj(v)) {
      errors.push("the file is not a YAML map (it should start with keys like id: and name:)");
      return undefined;
    }
    return v;
  } catch (e) {
    errors.push(`YAML: ${(e as Error).message.split("\n")[0]}`);
    return undefined;
  }
}

export interface LoadSiteOptions {
  /** Sites that can be extended, by id (YAML text or parsed objects). */
  builtins?: Record<string, string | Raw>;
  /** Extra validation of the finished site (for example building the network). */
  verify?: (site: Site) => string[];
}

// Field names, to catch typos such as "adress:" that would otherwise be ignored.
const KEYS = {
  top: ["schema", "id", "name", "description", "extends", "rename", "process", "hosts", "zones", "conduits", "devices", "network", "hmi", "polling", "flows", "standby", "ids"],
  network: ["firewall", "switches"],
  firewall: ["name", "vendor", "model", "firmware", "hostname", "ip", "otSignatures"],
  switch: ["name", "remove", "vendor", "model", "firmware", "hostname", "ip", "ports"],
  process: ["model", "tags", "params"],
  host: ["name", "remove", "role", "ip", "level", "kind", "services", "os", "user", "description", "mfa"],
  zone: ["name", "remove", "description", "sl", "hosts", "vlan", "port"],
  conduit: ["name", "remove", "zones", "rules"],
  device: ["remove", "title", "vendor", "product", "revision", "points"],
  point: ["addr", "tag", "signal", "description", "units"],
  hmi: ["host", "device", "timeout"],
  poll: ["from", "to", "service", "fc", "every", "when"],
  flow: ["id", "remove", "title", "why", "from", "to", "service", "fc", "paths", "when"],
  standby: ["centre", "backupName", "backup", "lost"],
  hop: ["from", "to", "service", "fc"],
  ids: ["writers", "safety", "identify"],
};

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Warnings for field names the simulator does not know. */
export function unknownFields(raw: Raw): string[] {
  const out: string[] = [];
  const check = (obj: unknown, allowed: string[], where: string) => {
    if (!isObj(obj)) return;
    for (const k of Object.keys(obj)) {
      if (allowed.includes(k)) continue;
      const near = allowed.find((a) => distance(a, k.toLowerCase()) <= 2);
      out.push(`${where}: unknown field "${k}" is ignored${near ? `. Did you mean "${near}"?` : ""}`);
    }
  };
  const list = (v: unknown, allowed: string[], where: string, label: (x: Raw, i: number) => string) => {
    if (Array.isArray(v)) v.forEach((x, i) => check(x, allowed, `${where} ${isObj(x) ? label(x, i) : i + 1}`));
  };
  check(raw, KEYS.top, "site");
  check(raw.process, KEYS.process, "process");
  list(raw.hosts, KEYS.host, "host", (x, i) => String(x.name ?? i + 1));
  list(raw.zones, KEYS.zone, "zone", (x, i) => String(x.name ?? i + 1));
  list(raw.conduits, KEYS.conduit, "conduit", (x, i) => String(x.name ?? i + 1));
  list(raw.polling, KEYS.poll, "polling", (_x, i) => String(i + 1));
  list(raw.flows, KEYS.flow, "flow", (x, i) => String(x.id ?? i + 1));
  if (Array.isArray(raw.flows))
    for (const f of raw.flows) if (isObj(f) && Array.isArray(f.paths)) for (const p of f.paths) list(p, KEYS.hop, `flow ${String(f.id)} hop`, (_x, i) => String(i + 1));
  check(raw.hmi, KEYS.hmi, "hmi");
  check(raw.standby, KEYS.standby, "standby");
  check(raw.network, KEYS.network, "network");
  if (isObj(raw.network)) {
    check(raw.network.firewall, KEYS.firewall, "network.firewall");
    list(raw.network.switches, KEYS.switch, "switch", (x, i) => String(x.name ?? i + 1));
  }
  check(raw.ids, KEYS.ids, "ids");
  if (isObj(raw.devices))
    for (const [name, d] of Object.entries(raw.devices)) {
      check(d, KEYS.device, `device ${name}`);
      if (isObj(d) && isObj(d.points))
        for (const [t, pts] of Object.entries(d.points)) list(pts, KEYS.point, `device ${name} ${t}`, (x, i) => `address ${String(x.addr ?? i)}`);
    }
  return out;
}

export function loadSite(input: string | Raw, opts: LoadSiteOptions = {}): SiteLoadResult {
  const errors: string[] = [];
  const raw = typeof input === "string" ? parseSiteText(input, errors) : input;
  if (!raw) return { errors, warnings: [] };
  const builtins: Record<string, Raw> = {};
  for (const [id, v] of Object.entries(opts.builtins ?? {})) {
    const b = typeof v === "string" ? parseSiteText(v, []) : v;
    if (b) builtins[id] = b;
  }
  const { raw: full, chain } = resolveRaw(raw, builtins, errors);
  if (errors.length) return { errors, warnings: [] };
  const c = new Checker();
  c.warnings.push(...unknownFields(raw));
  const site = normalize(full, chain, c);
  if (site && opts.verify) c.errors.push(...opts.verify(site));
  return c.errors.length ? { errors: c.errors, warnings: c.warnings } : { site, errors: [], warnings: c.warnings };
}

/** The host that plays a role, if any. */
export function hostByRole(site: Site, role: string): SiteHost | undefined {
  return site.hosts.find((h) => h.role === role);
}

/** Does this site share its labs with another (same site, or extends it)? */
export function siteCompatible(site: Site, labSite: string): boolean {
  return site.id === labSite || site.extends.includes(labSite);
}
