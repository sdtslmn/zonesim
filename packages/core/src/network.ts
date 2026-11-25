// The plant network: hosts, the zones the learner groups them into, and the
// conduits (with firewall rules) that connect zones.
//
// Policy model, kept close to IEC 62443-3-2 thinking:
// - Hosts in the same zone can talk freely.
// - Traffic between two zones needs a conduit between exactly those zones.
// - A conduit is a firewall: rules are checked top-down, first match wins,
//   and anything that matches no rule is denied.
// - Rules are one-way (from -> to); replies to an allowed request are fine.
// - Modbus rules can be limited to function codes (deep packet inspection).

import { UserError, parseNumberList } from "./util.js";
import { READ_FCS, WRITE_FCS } from "./modbus.js";
import type { Site } from "./site.js";

export type ServiceName = "modbus" | "http" | "https" | "rdp" | "ssh" | "icmp";

export const SERVICES: Record<ServiceName, { port: number; label: string }> = {
  ssh: { port: 22, label: "22/tcp" },
  http: { port: 80, label: "80/tcp" },
  https: { port: 443, label: "443/tcp" },
  modbus: { port: 502, label: "502/tcp" },
  rdp: { port: 3389, label: "3389/tcp" },
  icmp: { port: 0, label: "icmp" },
};

export const SERVICE_NAMES = Object.keys(SERVICES) as ServiceName[];

export function serviceByPort(port: number): ServiceName | undefined {
  return SERVICE_NAMES.find((s) => SERVICES[s].port === port && s !== "icmp");
}

export const LEVEL_NAMES: Record<string, string> = {
  "5": "Internet",
  "4": "Enterprise",
  "3.5": "DMZ",
  "3": "Operations",
  "2": "Supervisory",
  "1": "Control",
  "0": "Process",
};

export interface Host {
  name: string;
  ip: string;
  /** Purdue level: 5 internet, 4 enterprise, 3.5 DMZ, 3 operations, 2 supervisory, 1 control, 0 process. */
  level: number;
  /** The role labs refer to, e.g. plc or hmi. */
  role?: string;
  description: string;
  os: string;
  /** The account you are logged in as when you ssh to the host. */
  user: string;
  kind: "external" | "it" | "dmz" | "ot";
  services: ServiceName[];
  zone: string;
  mfa: boolean;
}

export interface Zone {
  name: string;
  /** Target security level (SL-T, 1 to 4) from the risk assessment. */
  sl?: number;
  description?: string;
}

export type Endpoint = { type: "any" } | { type: "host"; name: string } | { type: "zone"; name: string };

export interface Rule {
  action: "allow" | "deny";
  src: Endpoint;
  dst: Endpoint;
  /** "any", a service name, or "tcp/<port>". */
  service: string;
  /** Allowed Modbus function codes. Undefined means all. */
  fc?: number[];
  hits: number;
}

export interface Conduit {
  name: string;
  zones: [string, string];
  rules: Rule[];
}

export interface Verdict {
  /** The policy lets the traffic through. */
  allowed: boolean;
  /** Allowed and something listens on the port. */
  delivered: boolean;
  reason: string;
  conduit?: string;
  /** 1-based rule number that decided, if any. */
  rule?: number;
  intraZone?: boolean;
  blockedBy?: "no-conduit" | "default-deny" | "deny-rule" | "function-code";
}

const NAME_RE = /^[a-z][a-z0-9-]{0,23}$/;

export function endpointText(e: Endpoint): string {
  return e.type === "any" ? "any" : e.name;
}

export function ruleText(r: Rule): string {
  const fc = r.fc ? ` fc ${r.fc.join(",")}` : "";
  return `${r.action} from ${endpointText(r.src)} to ${endpointText(r.dst)} ${r.service}${fc}`;
}

export class Network {
  hosts: Host[];
  zones: Zone[];
  conduits: Conduit[];

  constructor(site: Site) {
    // The network as found, from the site file.
    const zoneOf = new Map<string, string>();
    for (const z of site.zones) for (const h of z.hosts) zoneOf.set(h, z.name);
    this.hosts = site.hosts.map((h) => ({
      name: h.name,
      ip: h.ip,
      level: h.level,
      role: h.role,
      description: h.description,
      os: h.os,
      user: h.user,
      kind: h.kind,
      services: h.services as ServiceName[],
      zone: zoneOf.get(h.name) ?? "",
      mfa: false,
    }));
    this.zones = site.zones.map((z) => ({ name: z.name, ...(z.sl ? { sl: z.sl } : {}), ...(z.description ? { description: z.description } : {}) }));
    this.conduits = site.conduits.map((c) => ({ name: c.name, zones: [c.zones[0], c.zones[1]] as [string, string], rules: [] }));
    for (const c of site.conduits) {
      for (const text of c.rules) {
        try {
          const { rule, at } = this.parseRule(text.trim().split(/\s+/), c.name);
          this.addRule(c.name, rule, at);
        } catch (e) {
          throw new UserError(`conduit ${c.name}: rule "${text}": ${(e as Error).message}`);
        }
      }
    }
  }

  /**
   * Parse a rule: "allow from SRC to DST SERVICE [fc CODES] [at N]" (the
   * leading action word is included). "from" and "to" are optional.
   */
  parseRule(words: string[], conduitName?: string): { rule: Omit<Rule, "hits">; at?: number } {
    const [actionWord, ...rest] = words;
    const action = (actionWord ?? "").toLowerCase();
    if (action !== "allow" && action !== "deny") throw new UserError(`a rule starts with allow or deny`);
    const usage = `${action} from SRC to DST SERVICE${action === "allow" ? " [fc CODES]" : ""} [at N]`;
    const parts: string[] = [];
    let fc: number[] | undefined;
    let at: number | undefined;
    for (let i = 0; i < rest.length; i++) {
      const w = rest[i].toLowerCase();
      if (w === "from" || w === "to") continue;
      if (w === "fc" || w === "--fc") {
        if (!rest[i + 1]) throw new UserError("fc needs a list of function codes, e.g. fc 3,4");
        fc = this.parseFunctionCodes(rest[++i]);
        continue;
      }
      if (w.startsWith("fc=")) {
        fc = this.parseFunctionCodes(w.slice(3));
        continue;
      }
      if (w === "at" || w === "--at") {
        at = parseInt(rest[++i] ?? "", 10);
        if (!Number.isInteger(at) || at < 1) throw new UserError("at needs a rule number, e.g. at 1");
        continue;
      }
      parts.push(rest[i]);
    }
    if (parts.length !== 3) throw new UserError(`usage: ${conduitName ? usage : usage}`);
    if (fc && action === "deny") throw new UserError("function code lists go on allow rules. Traffic that matches no allow rule is denied anyway.");
    const rule: Omit<Rule, "hits"> = { action, src: this.parseEndpoint(parts[0]), dst: this.parseEndpoint(parts[1]), service: this.parseService(parts[2]) };
    if (fc) rule.fc = fc;
    return { rule, at };
  }

  // ------------------------------------------------------------ lookup

  host(ref: string): Host | undefined {
    const r = ref.toLowerCase();
    return this.hosts.find((h) => h.name === r || h.ip === r);
  }

  needHost(ref: string): Host {
    const h = this.host(ref);
    if (!h) throw new UserError(`unknown host "${ref}". Type hosts to see them.`);
    return h;
  }

  zone(name: string): Zone | undefined {
    return this.zones.find((z) => z.name === name.toLowerCase());
  }

  needZone(name: string): Zone {
    const z = this.zone(name);
    if (!z) throw new UserError(`unknown zone "${name}". Type zone list to see them.`);
    return z;
  }

  conduit(name: string): Conduit | undefined {
    return this.conduits.find((c) => c.name === name.toLowerCase());
  }

  needConduit(name: string): Conduit {
    const c = this.conduit(name);
    if (!c) throw new UserError(`unknown conduit "${name}". Type conduit list to see them.`);
    return c;
  }

  hostsIn(zone: string): Host[] {
    return this.hosts.filter((h) => h.zone === zone);
  }

  conduitBetween(a: string, b: string): Conduit | undefined {
    return this.conduits.find((c) => (c.zones[0] === a && c.zones[1] === b) || (c.zones[0] === b && c.zones[1] === a));
  }

  // ------------------------------------------------------------ changes

  createZone(name: string, opts: { sl?: number; description?: string } = {}): Zone {
    const n = name.toLowerCase();
    if (!NAME_RE.test(n)) throw new UserError(`zone names use lower-case letters, digits and dashes, start with a letter, and are at most 24 characters`);
    if (n === "any") throw new UserError(`"any" is a keyword in firewall rules, pick another name`);
    if (this.zone(n)) throw new UserError(`zone "${n}" already exists`);
    if (this.host(n)) throw new UserError(`"${n}" is a host name. Pick a zone name that is not a host, so rules stay unambiguous.`);
    if (this.conduit(n)) throw new UserError(`"${n}" is a conduit name, pick another name`);
    if (opts.sl !== undefined && (!Number.isInteger(opts.sl) || opts.sl < 1 || opts.sl > 4)) throw new UserError("the target security level (--sl) is 1, 2, 3 or 4");
    const z: Zone = { name: n, ...opts };
    this.zones.push(z);
    return z;
  }

  setZone(name: string, opts: { sl?: number; description?: string }): Zone {
    const z = this.needZone(name);
    if (opts.sl !== undefined) {
      if (!Number.isInteger(opts.sl) || opts.sl < 1 || opts.sl > 4) throw new UserError("the target security level (--sl) is 1, 2, 3 or 4");
      z.sl = opts.sl;
    }
    if (opts.description !== undefined) z.description = opts.description;
    return z;
  }

  /** Move hosts into a zone. Returns the zones they came from. */
  addToZone(zone: string, hostRefs: string[]): { host: Host; from: string }[] {
    const z = this.needZone(zone);
    const hosts = hostRefs.map((r) => this.needHost(r));
    return hosts.map((h) => {
      const from = h.zone;
      h.zone = z.name;
      return { host: h, from };
    });
  }

  /** Delete a zone. It must be empty. Conduits to it are deleted too and returned. */
  deleteZone(name: string): Conduit[] {
    const z = this.needZone(name);
    const members = this.hostsIn(z.name);
    if (members.length) throw new UserError(`zone ${z.name} still holds ${members.map((h) => h.name).join(", ")}. Move them to another zone first.`);
    const gone = this.conduits.filter((c) => c.zones.includes(z.name));
    this.conduits = this.conduits.filter((c) => !gone.includes(c));
    this.zones = this.zones.filter((x) => x !== z);
    return gone;
  }

  createConduit(name: string, a: string, b: string): Conduit {
    const n = name.toLowerCase();
    if (!NAME_RE.test(n)) throw new UserError(`conduit names use lower-case letters, digits and dashes, start with a letter, and are at most 24 characters`);
    if (this.conduit(n)) throw new UserError(`conduit "${n}" already exists`);
    if (this.zone(n) || this.host(n) || n === "any") throw new UserError(`"${n}" is already used as a zone or host name, pick another name`);
    const za = this.needZone(a);
    const zb = this.needZone(b);
    if (za === zb) throw new UserError("a conduit connects two different zones. Hosts inside one zone already talk freely.");
    const existing = this.conduitBetween(za.name, zb.name);
    if (existing) throw new UserError(`zones ${za.name} and ${zb.name} are already connected by conduit ${existing.name}. Add rules to it instead.`);
    const c: Conduit = { name: n, zones: [za.name, zb.name], rules: [] };
    this.conduits.push(c);
    return c;
  }

  deleteConduit(name: string): Conduit {
    const c = this.needConduit(name);
    this.conduits = this.conduits.filter((x) => x !== c);
    return c;
  }

  parseEndpoint(text: string): Endpoint {
    const t = text.toLowerCase();
    if (t === "any") return { type: "any" };
    const h = this.host(t);
    if (h) return { type: "host", name: h.name };
    const z = this.zone(t);
    if (z) return { type: "zone", name: z.name };
    throw new UserError(`"${text}" is not a host, a zone or "any"`);
  }

  parseService(text: string): string {
    const t = text.toLowerCase();
    if (t === "any" || (SERVICE_NAMES as string[]).includes(t)) return t;
    if (t === "ping") return "icmp";
    const m = t.match(/^tcp\/(\d{1,5})$/);
    if (m) {
      const named = serviceByPort(parseInt(m[1], 10));
      return named ?? t;
    }
    throw new UserError(`unknown service "${text}". Use one of ${SERVICE_NAMES.join(", ")}, any, or tcp/<port>.`);
  }

  parseFunctionCodes(text: string): number[] {
    const t = text.toLowerCase();
    if (t === "read") return [...READ_FCS];
    if (t === "write") return [...WRITE_FCS];
    const list = parseNumberList(t);
    for (const n of list) if (n < 1 || n > 127) throw new UserError(`function code ${n} is out of range (1 to 127)`);
    return list;
  }

  addRule(conduit: string, rule: Omit<Rule, "hits">, position?: number): { rule: Rule; index: number; warnings: string[] } {
    const c = this.needConduit(conduit);
    const r: Rule = { ...rule, hits: 0 };
    if (r.fc && r.service !== "modbus") throw new UserError("function codes (fc) only apply to the modbus service");
    const warnings: string[] = [];
    const sideOf = (e: Endpoint): string[] => {
      if (e.type === "any") return [...c.zones];
      if (e.type === "zone") return [e.name];
      return [this.host(e.name)!.zone];
    };
    const srcSides = sideOf(r.src).filter((z) => c.zones.includes(z));
    const dstSides = sideOf(r.dst).filter((z) => c.zones.includes(z));
    if (!srcSides.length) warnings.push(`${endpointText(r.src)} is not in zone ${c.zones[0]} or ${c.zones[1]}, so this rule will not match until it is.`);
    if (!dstSides.length) warnings.push(`${endpointText(r.dst)} is not in zone ${c.zones[0]} or ${c.zones[1]}, so this rule will not match until it is.`);
    if (r.action === "allow" && (r.src.type === "any" || r.dst.type === "any" || r.service === "any")) warnings.push(`this rule uses "any". Least privilege means naming the hosts and the service.`);
    const index = position === undefined ? c.rules.length : Math.max(0, Math.min(c.rules.length, position - 1));
    c.rules.splice(index, 0, r);
    return { rule: r, index: index + 1, warnings };
  }

  deleteRule(conduit: string, n: number): Rule {
    const c = this.needConduit(conduit);
    if (!Number.isInteger(n) || n < 1 || n > c.rules.length) throw new UserError(`conduit ${c.name} has no rule ${n}. Type fw list ${c.name} to see the numbers.`);
    return c.rules.splice(n - 1, 1)[0];
  }

  // ------------------------------------------------------------ policy

  private endpointMatches(e: Endpoint, h: Host): boolean {
    if (e.type === "any") return true;
    if (e.type === "host") return e.name === h.name;
    return h.zone === e.name;
  }

  private serviceMatches(ruleService: string, service: ServiceName): boolean {
    if (ruleService === "any") return true;
    if (ruleService === service) return true;
    const m = ruleService.match(/^tcp\/(\d+)$/);
    return !!m && service !== "icmp" && SERVICES[service].port === parseInt(m[1], 10);
  }

  /**
   * Would traffic from src to dst on this service get through? With a Modbus
   * function code the deep packet inspection is applied too; without one only
   * the connection is checked (what a port scan sees).
   */
  evaluate(src: Host, dst: Host, service: ServiceName, fc?: number, opts: { count?: boolean } = {}): Verdict {
    const listens = service === "icmp" || dst.services.includes(service);
    const done = (v: Omit<Verdict, "delivered">): Verdict => ({ ...v, delivered: v.allowed && listens });
    if (src === dst) return done({ allowed: true, reason: "same host", intraZone: true });
    if (src.zone === dst.zone) return done({ allowed: true, reason: `same zone (${src.zone})`, intraZone: true });
    const c = this.conduitBetween(src.zone, dst.zone);
    if (!c) return done({ allowed: false, reason: `no conduit between zones ${src.zone} and ${dst.zone}`, blockedBy: "no-conduit" });
    let fcMiss: number | undefined;
    for (let i = 0; i < c.rules.length; i++) {
      const r = c.rules[i];
      if (!this.endpointMatches(r.src, src) || !this.endpointMatches(r.dst, dst) || !this.serviceMatches(r.service, service)) continue;
      if (r.action === "allow" && r.fc && fc !== undefined && !r.fc.includes(fc)) {
        fcMiss ??= i + 1;
        continue;
      }
      if (opts.count) r.hits++;
      if (r.action === "deny") return done({ allowed: false, reason: `denied by conduit ${c.name} rule ${i + 1}`, conduit: c.name, rule: i + 1, blockedBy: "deny-rule" });
      return done({ allowed: true, reason: `allowed by conduit ${c.name} rule ${i + 1}`, conduit: c.name, rule: i + 1 });
    }
    if (fcMiss !== undefined) return done({ allowed: false, reason: `function code ${fc} is not allowed by conduit ${c.name} rule ${fcMiss}`, conduit: c.name, rule: fcMiss, blockedBy: "function-code" });
    return done({ allowed: false, reason: `no rule in conduit ${c.name} allows it (default deny)`, conduit: c.name, blockedBy: "default-deny" });
  }

  // ------------------------------------------------------------ copy

  toJSON(): { hosts: Host[]; zones: Zone[]; conduits: Conduit[] } {
    return JSON.parse(JSON.stringify({ hosts: this.hosts, zones: this.zones, conduits: this.conduits }));
  }
}
