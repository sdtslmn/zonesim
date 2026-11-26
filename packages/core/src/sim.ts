// The simulation: a site's process, its controllers, the network policy, the
// traffic the plant generates, a passive OT intrusion detection sensor, and
// the logs the learner investigates (flows, firewall log, alerts).
//
// Time is virtual. In the browser it follows the wall clock; lab checks and
// tests move it forward instantly with settle().

import { WRITE_FCS, FC_NAMES, EXCEPTIONS, type ModbusReply, type ModbusRequest, type PointTable } from "./modbus.js";
import { Network, type Host, type ServiceName, type Verdict } from "./network.js";
import { Infra } from "./infra.js";
import { requiredFlowStatus, riskChecks, type FlowStatus, type RiskCheck } from "./checks.js";
import { PROCESS_MODELS, WaterTank, type ProcessModel, type Readout } from "./process/index.js";
import { Controller } from "./device.js";
import { builtinSite } from "./sites/index.js";
import type { Site, SiteFlow } from "./site.js";
import { UserError } from "./util.js";
import { Sensor, fcText, linkText, type Anomaly, type LinkObs } from "./sensor.js";

export const STEP = 0.5;
/** Longest stretch of time the plant catches up on at once (e.g. after a laptop sleeps). */
const MAX_CATCH_UP = 600;

export interface SimOptions {
  /** The plant to simulate. Defaults to the built-in Riverside site. */
  site?: Site;
  /** Milliseconds, like Date.now. Pass a fixed function to drive time only with settle(). */
  clock?: () => number;
}

export interface TrafficEvent {
  seq: number;
  t: number;
  src: string;
  dst: string;
  service: ServiceName;
  fc?: number;
  allowed: boolean;
  delivered: boolean;
  reason: string;
  conduit?: string;
  /** Rule number in the conduit that decided it. */
  rule?: number;
  /** Zones of the two hosts when it happened. */
  srcZone?: string;
  dstZone?: string;
  background: boolean;
  /** What the request did, e.g. "write single coil (fc 5): coil 0 = 0". */
  detail?: string;
}

export interface Conversation {
  src: string;
  dst: string;
  service: ServiceName;
  fcs: number[];
  count: number;
  blocked: number;
  firstT: number;
  lastT: number;
  lastOk: boolean;
  lastReason: string;
  background: boolean;
}

export type Severity = "critical" | "high" | "medium" | "low";

export interface Alert {
  id: string;
  t: number;
  lastT: number;
  severity: Severity;
  title: string;
  detail: string;
  src?: string;
  dst?: string;
  count: number;
  acked: boolean;
  source: "ids" | "process";
  key: string;
  /** MITRE ATT&CK for ICS technique IDs. */
  attack?: string[];
  /** What an analyst should check first. */
  advice?: string;
  /** For anomaly alerts: the links and function codes outside the baseline. */
  anomaly?: LinkObs[];
  /** Closed by learning what it saw into the sensor's baseline. */
  learned?: boolean;
}

export interface RaiseOptions {
  severity: Severity;
  title: string;
  detail: string;
  src?: string;
  dst?: string;
  source: "ids" | "process";
  attack?: string[];
  advice?: string;
  anomaly?: LinkObs[];
}

const SEV_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export interface FwLogEntry {
  t: number;
  conduit: string;
  src: string;
  dst: string;
  service: ServiceName;
  fc?: number;
  reason: string;
}

/** An operator action on the HMI screen, and what came of it. */
export interface HmiAction {
  t: number;
  /** What the operator did, e.g. "T-101 stop level 70 %". */
  text: string;
  ok: boolean;
  /** What happened: "done", "no response from plc-1", "plc-1 rejected it". */
  result: string;
  /** Why, for learners: the firewall verdict or the Modbus exception. */
  detail?: string;
}

/** Where the HMI reads a signal. */
export interface HmiSource {
  device: string;
  table: PointTable;
  addr: number;
  tag: string;
}

export class Sim {
  readonly site: Site;
  readonly plant: ProcessModel;
  readonly net: Network;
  /** Switches and the firewall: the devices that carry the zones and conduits. */
  readonly infra: Infra;
  readonly devices = new Map<string, Controller>();
  /** The passive OT monitoring sensor on a mirror port. */
  readonly sensor: Sensor;
  /** Plant time in seconds since the simulation started. */
  t = 0;
  events: TrafficEvent[] = [];
  conversations = new Map<string, Conversation>();
  alerts: Alert[] = [];
  fwlog: FwLogEntry[] = [];
  /** The process trends every 5 seconds, in engineering units, in the order of plant.trends. */
  trend: { t: number; values: number[] }[] = [];
  /** Signal values the HMI last read, and when it last heard from each device. */
  hmiValues: Record<string, number> = {};
  hmiLast: Record<string, number> = {};
  /** What operators did on the HMI screen, newest last. */
  hmiActions: HmiAction[] = [];
  /** True while the backup centre has taken over from the lost main centre. */
  takeover = false;

  private seq = 0;
  private alertSeq = 1000;
  private clock: () => number;
  private realStart: number;
  private offset = 0;
  private due: Record<string, number> = {};
  private scans = new Map<string, { t: number; target: string }[]>();
  private activeAlarms = new Set<string>();
  private hmiCommOk = true;
  private listeners = new Set<() => void>();

  constructor(opts: SimOptions = {}) {
    this.site = opts.site ?? builtinSite();
    const type = PROCESS_MODELS[this.site.process.model];
    this.plant = type.create(this.site.process.params, this.site.process.tags);
    this.net = new Network(this.site);
    this.infra = new Infra(this.site, this.net);
    this.sensor = new Sensor(this.site);
    for (const [host, def] of Object.entries(this.site.devices)) this.devices.set(host, new Controller(host, def, this.plant));
    for (const c of this.devices.values()) for (const t of ["coil", "di", "ir", "hr"] as const) for (const p of c.def.points[t]) this.hmiValues[p.signal] = this.plant.get(p.signal);
    this.clock = opts.clock ?? (() => Date.now());
    this.realStart = this.clock();
  }

  /** The water-tank model, when the site uses it (the plant views need its fields). */
  get tank(): WaterTank | undefined {
    return this.plant instanceof WaterTank ? this.plant : undefined;
  }

  /** The host that plays a role in this site. */
  roleHost(role: string): Host | undefined {
    return this.net.hosts.find((h) => h.role === role);
  }

  device(host: string): Controller | undefined {
    return this.devices.get(host);
  }

  /** The plant time the wall clock says it should be. */
  now(): number {
    return (this.clock() - this.realStart) / 1000 + this.offset;
  }

  /** Catch the plant up with the wall clock. */
  advance(): void {
    const target = this.now();
    if (target - this.t > MAX_CATCH_UP) this.offset -= target - this.t - MAX_CATCH_UP;
    const end = this.now();
    let stepped = false;
    while (this.t + STEP <= end + 1e-9) {
      this.step(STEP);
      stepped = true;
    }
    if (stepped) this.emit();
  }

  /** Jump the plant forward by some seconds, instantly. */
  settle(seconds: number): void {
    this.advance();
    this.offset += Math.max(0, seconds);
    this.advance();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    for (const fn of this.listeners) fn();
  }

  private every(key: string, period: number, offset = 0): boolean {
    this.due[key] ??= offset;
    if (this.t + 1e-9 < this.due[key]) return false;
    this.due[key] = this.t + period;
    return true;
  }

  private step(dt: number): void {
    this.t = Math.round((this.t + dt) * 1000) / 1000;
    this.plant.step(dt);
    this.backgroundTraffic();
    this.processAlarms();
    if (this.every("trend", 5)) {
      this.trend.push({ t: this.t, values: this.plant.trends.map((x) => this.plant.get(x.signal) * x.scale) });
      if (this.trend.length > 240) this.trend.shift();
    }
  }

  // ------------------------------------------------------------ background traffic

  private backgroundTraffic(): void {
    const hmi = this.site.hmi;
    const hmiHost = this.hmiHost;
    this.site.polling.forEach((p, i) => {
      if (!this.modeActive(p.when)) return;
      if (!this.every(`poll-${i}`, p.every, i + 1)) return;
      if (this.net.host(p.from)?.down) return;
      if (p.service !== "modbus") {
        this.send(p.from, p.to, p.service as ServiceName, { background: true });
        return;
      }
      let ok = true;
      for (const fc of p.fc ?? [3]) {
        const r = this.modbus(p.from, p.to, { fc, addr: 0, count: 1 }, { background: true });
        ok &&= !!r.verdict.delivered;
      }
      if (ok && hmi && p.from === hmiHost) {
        this.hmiLast[p.to] = this.t;
        const dev = this.devices.get(p.to);
        if (dev) for (const t of ["coil", "di", "ir", "hr"] as const) for (const pt of dev.def.points[t]) this.hmiValues[pt.signal] = this.plant.get(pt.signal);
      }
    });
    if (hmi) {
      const commOk = this.t < hmi.timeout || this.t - (this.hmiLast[hmi.device] ?? 0) <= hmi.timeout;
      if (!commOk && this.hmiCommOk) this.raise({ severity: "medium", title: `HMI lost communication with ${hmi.device}`, detail: `${hmiHost} has had no answer from ${hmi.device} for more than ${hmi.timeout} seconds. Operators are blind.`, src: hmiHost, dst: hmi.device, source: "process", advice: `Check the path from ${hmiHost} to ${hmi.device}: the conduit rules (fw log shows what was blocked) and both switch ports.` });
      this.hmiCommOk = commOk;
    }
  }

  get hmiOnline(): boolean {
    return this.hmiCommOk;
  }

  /** The host that runs the operator screen now: the backup centre during a takeover. */
  get hmiHost(): string {
    const h = this.site.hmi;
    if (!h) return "";
    return this.takeover && this.site.standby ? this.site.standby.backup : h.host;
  }

  /** Does a poll or flow with this when apply right now? */
  modeActive(when?: "normal" | "takeover"): boolean {
    return !when || (when === "takeover") === this.takeover;
  }

  /**
   * The main control centre is lost: its hosts stop, and the backup centre
   * takes over the operator screen and its own polls. The firewall rules for
   * the backup are whatever the design says: if they are off, someone has to
   * turn them on as part of the takeover.
   */
  startTakeover(): void {
    const sb = this.site.standby;
    if (!sb) throw new UserError("This site has no backup control centre.");
    if (this.takeover) return;
    this.advance();
    this.takeover = true;
    for (const name of sb.lost) {
      const h = this.net.host(name);
      if (h) h.down = `the ${sb.centre} is out of action`;
    }
    this.infra.refreshLinks();
    // The backup's database was kept in step: its values count as fresh until its own polls are overdue.
    for (const d of this.devices.keys()) this.hmiLast[d] = this.t;
    this.raise({ severity: "high", title: `${sb.centre} lost: the ${sb.backupName} must take over`, detail: `${sb.lost.join(", ")} are out of action. ${sb.backup} now runs the operator screen and needs its takeover flows.`, src: sb.backup, source: "process" });
    this.emit();
  }

  /** The main centre is back and takes control again. */
  endTakeover(): void {
    const sb = this.site.standby;
    if (!sb) throw new UserError("This site has no backup control centre.");
    if (!this.takeover) return;
    this.advance();
    this.takeover = false;
    for (const name of sb.lost) {
      const h = this.net.host(name);
      if (h) delete h.down;
    }
    this.infra.refreshLinks();
    for (const d of this.devices.keys()) this.hmiLast[d] = this.t;
    this.emit();
  }

  /** Controllers the HMI polls, its own controller first. */
  hmiDevices(): string[] {
    const h = this.site.hmi;
    if (!h) return [];
    const host = this.hmiHost;
    const polled = this.site.polling.filter((p) => p.from === host && p.service === "modbus" && this.devices.has(p.to) && this.modeActive(p.when)).map((p) => p.to);
    return [...new Set([h.device, ...polled])].filter((d) => this.devices.has(d));
  }

  /** Where the HMI reads a signal, or undefined if no controller it polls has it. */
  hmiSource(signal: string): HmiSource | undefined {
    for (const name of this.hmiDevices()) {
      const d = this.devices.get(name)!;
      for (const table of ["coil", "di", "ir", "hr"] as const) {
        const p = d.def.points[table].find((x) => x.signal === signal);
        if (p) return { device: name, table, addr: p.addr, tag: p.tag };
      }
    }
    return undefined;
  }

  /** True when the HMI heard from this controller recently enough to trust its values. */
  hmiFresh(device: string): boolean {
    const h = this.site.hmi;
    if (!h) return false;
    return this.t < h.timeout || this.t - (this.hmiLast[device] ?? 0) <= h.timeout;
  }

  /**
   * The point the HMI writes for a signal: a coil or holding register on the
   * HMI's own controller, or on another controller it polls where the IDS
   * baseline lists it as a normal writer. Safety systems stay read-only.
   */
  hmiWritable(signal: string): HmiSource | undefined {
    const h = this.site.hmi;
    const src = this.hmiSource(signal);
    if (!h || !src || (src.table !== "coil" && src.table !== "hr")) return undefined;
    if (this.site.ids.safety.includes(src.device)) return undefined;
    return src.device === h.device || (this.site.ids.writers[src.device] ?? []).includes(this.hmiHost) ? src : undefined;
  }

  /**
   * An operator action on the HMI: a Modbus write from the HMI host to its
   * controller, through the network like any other traffic. raw is the
   * register value (or 0 and 1 for a coil).
   */
  hmiWrite(signal: string, raw: number, text: string): HmiAction {
    this.advance();
    const h = this.site.hmi;
    const point = this.hmiWritable(signal);
    let action: HmiAction;
    if (!h || !point) action = { t: this.t, text, ok: false, result: "not available on this HMI" };
    else {
      const value = point.table === "coil" ? (raw ? 1 : 0) : Math.round(raw);
      const fc = point.table === "coil" ? 5 : 6;
      const r = this.modbus(this.hmiHost, point.device, { fc, addr: point.addr, values: [value] });
      if (!r.verdict.delivered) action = { t: this.t, text, ok: false, result: `no response from ${point.device}`, detail: r.verdict.reason };
      else if (!r.reply?.ok) {
        const ex = r.reply?.exception;
        action = { t: this.t, text, ok: false, result: `${point.device} rejected it`, detail: ex !== undefined ? `Modbus exception ${ex} (${EXCEPTIONS[ex] ?? "unknown"})` : undefined };
      } else {
        // The HMI reads the point back straight after a write.
        this.hmiValues[signal] = this.plant.get(signal);
        action = { t: this.t, text, ok: true, result: "done", detail: `fc ${fc} ${point.table} ${point.addr} (${point.tag}) = ${value}` };
      }
    }
    this.hmiActions.push(action);
    if (this.hmiActions.length > 100) this.hmiActions.shift();
    this.emit();
    return action;
  }

  /** Name of the safety system host, for labels. */
  get safetyName(): string | undefined {
    return this.roleHost("sis")?.name ?? this.site.ids.safety[0];
  }

  /** Live process values for the views. */
  readouts(): Readout[] {
    return this.plant.readouts((sig) => this.plant.get(sig), { safety: this.safetyName });
  }

  /** What the operator screen shows: values from the last successful poll. */
  hmiReadouts(): Readout[] {
    return this.plant.readouts((sig) => this.hmiValues[sig] ?? NaN, { safety: this.safetyName }).filter((r) => r.hmi);
  }

  // ------------------------------------------------------------ traffic

  /** Send one request through the network policy and record it. */
  send(srcRef: string, dstRef: string, service: ServiceName, opts: { fc?: number; background?: boolean; detail?: string } = {}): Verdict {
    const src = this.net.needHost(srcRef);
    const dst = this.net.needHost(dstRef);
    const v = this.net.evaluate(src, dst, service, opts.fc, { count: true });
    const background = !!opts.background;
    this.events.push({ seq: ++this.seq, t: this.t, src: src.name, dst: dst.name, service, fc: opts.fc, allowed: v.allowed, delivered: v.delivered, reason: v.reason, conduit: v.conduit, rule: v.rule, srcZone: src.zone, dstZone: dst.zone, background, ...(opts.detail ? { detail: opts.detail } : {}) });
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400);

    const key = `${src.name}>${dst.name}>${service}>${background ? "plant" : "you"}`;
    let conv = this.conversations.get(key);
    if (!conv) {
      conv = { src: src.name, dst: dst.name, service, fcs: [], count: 0, blocked: 0, firstT: this.t, lastT: this.t, lastOk: true, lastReason: "", background };
      this.conversations.set(key, conv);
    }
    conv.count++;
    if (!v.delivered) conv.blocked++;
    conv.lastT = this.t;
    conv.lastOk = v.delivered;
    conv.lastReason = v.reason;
    if (opts.fc !== undefined && !conv.fcs.includes(opts.fc)) conv.fcs = [...conv.fcs, opts.fc].sort((a, b) => a - b);

    if (!v.allowed) {
      this.fwlog.push({ t: this.t, conduit: v.conduit ?? "(no conduit)", src: src.name, dst: dst.name, service, fc: opts.fc, reason: v.reason });
      if (this.fwlog.length > 300) this.fwlog.splice(0, this.fwlog.length - 300);
    }
    if (v.allowed) this.inspect(src, dst, service, v, opts.fc, opts.detail, background);
    return v;
  }

  /** A Modbus request from one host to a controller, over the network. */
  modbus(srcRef: string, dstRef: string, req: ModbusRequest, opts: { background?: boolean } = {}): { verdict: Verdict; reply?: ModbusReply } {
    const dst = this.net.needHost(dstRef);
    const verdict = this.send(srcRef, dst.name, "modbus", { fc: req.fc, background: opts.background, detail: describeRequest(req) });
    if (!verdict.delivered) return { verdict };
    const dev = this.devices.get(dst.name);
    if (!dev) return { verdict };
    const reply = dev.modbus(req);
    if (reply.deviceId) this.sensor.identify(this.t, dst.name, reply.deviceId);
    return { verdict, reply };
  }

  // ------------------------------------------------------------ detection

  /** The passive IDS sensor: it sees traffic that made it through the firewalls. */
  private inspect(src: Host, dst: Host, service: ServiceName, v: Verdict, fc: number | undefined, detail: string | undefined, background: boolean): void {
    const anomalies = this.sensor.observe(this.t, src, dst, service, fc, v.delivered);
    for (const a of anomalies) this.raiseAnomaly(a);
    if (background) return;
    const ids = this.site.ids;
    const what = detail ?? `function code ${fc}`;
    if (service === "modbus" && fc !== undefined && WRITE_FCS.includes(fc) && this.devices.has(dst.name)) {
      const impact = fc === 6 || fc === 16 ? "T0836" : "T0831";
      if (ids.safety.includes(dst.name)) {
        this.raise({ severity: "critical", title: "Modbus write to the safety system", detail: `${src.name} (${src.ip}) sent ${what} to ${dst.name}. Safety systems should never be written to over the plant network.`, src: src.name, dst: dst.name, source: "ids", attack: ["T0855", "T0880"], advice: `Treat this as an incident. Check ${dst.name}'s bypass and trip settings now, find out who uses ${src.name}, and make the safety zone read-only at its conduit.` });
      } else if (this.site.standby && src.name === this.site.standby.backup && !this.takeover) {
        const sb = this.site.standby;
        this.raise({ severity: "high", title: `Modbus write from the passive ${sb.backupName}`, detail: `${src.ip} (${src.name}) sent ${what} to ${dst.name} while the ${sb.centre} has control. The ${sb.backupName} should send nothing until it takes over.`, src: src.name, dst: dst.name, source: "ids", attack: ["T0855", impact], advice: `Ask the ${sb.centre} whether a takeover is under way. If not, check what changed on ${dst.name} and switch the ${sb.backupName}'s firewall rules off.` });
      } else if (!(ids.writers[dst.name] ?? []).includes(src.name)) {
        const normal = ids.writers[dst.name]?.length ? `Only ${ids.writers[dst.name].join(" and ")} normally write to this controller.` : "Nothing normally writes to this controller.";
        this.raise({ severity: "high", title: `Unauthorized Modbus write to ${dst.name}`, detail: `${src.ip} sent ${what} to ${dst.name}. ${normal}`, src: src.name, dst: dst.name, source: "ids", attack: ["T0855", impact], advice: `Check what changed on ${dst.name} against the process, and put it right from the HMI. Find out who uses ${src.name}, then block it from ${dst.name} at the conduit while the plant's own flows keep working.` });
      }
    }
    if (service === "modbus" && fc === 43 && !ids.identify.includes(src.name)) {
      this.raise({ severity: "low", title: "Modbus device identification read", detail: `${src.ip} asked ${dst.name} for its vendor, model and firmware (function code 43). This is typical reconnaissance.`, src: src.name, dst: dst.name, source: "ids", attack: ["T0888"], advice: `Find out why ${src.name} is fingerprinting controllers. Only engineering needs this, and an attacker uses it to pick an exploit.` });
    }
    if ((service === "rdp" || service === "ssh") && src.level >= 5 && dst.level <= 3) {
      this.raise({ severity: "high", title: "Remote access from the internet into the plant", detail: `${src.name} (${src.ip}) opened ${service} straight to ${dst.name}, a plant host, with no DMZ in between.`, src: src.name, dst: dst.name, source: "ids", attack: ["T0822"], advice: `Check who opened the session and whether it was booked. Remote sessions should end on a jump host in the DMZ, behind MFA.` });
    }
    if (v.allowed) {
      const list = (this.scans.get(src.name) ?? []).filter((x) => this.t - x.t <= 30);
      const target = `${dst.name}:${service}`;
      if (!list.some((x) => x.target === target)) list.push({ t: this.t, target });
      this.scans.set(src.name, list);
      if (list.length >= 8) {
        this.raise({ severity: "medium", title: "Network scan", detail: `${src.name} (${src.ip}) probed ${list.length} host and port pairs in 30 seconds.`, src: src.name, source: "ids", attack: ["T0846"], advice: `Find out what ${src.name} is and who uses it. A scan inside a plant network is rarely legitimate.` });
        this.scans.set(src.name, []);
      }
    }
  }

  /** Raise or extend an alert for traffic outside the sensor's baseline. */
  private raiseAnomaly(a: Anomaly): void {
    const l = a.link;
    const src = this.net.host(l.src);
    const toController = l.service === "modbus" && this.devices.has(l.dst);
    if (a.kind === "new-fc") {
      const known = this.sensor.learned(l.src, l.dst, l.service)?.fcs ?? [];
      const knownText = known.length ? `only ${known.join(", ")}` : "no function codes, only connections";
      const write = l.fc !== undefined && WRITE_FCS.includes(l.fc);
      this.raise({
        severity: write ? "high" : "medium",
        title: "New function code",
        detail: `${l.src} sent ${l.fc !== undefined ? fcText(l.fc) : "a new function code"} to ${l.dst}. The baseline has ${knownText} on this link.`,
        src: l.src,
        dst: l.dst,
        source: "ids",
        attack: write ? ["T0855"] : undefined,
        advice: `Ask whoever looks after ${l.src} whether this was planned. If it was, learn it with ids learn ID. If not, treat ${l.src} as suspect.`,
        anomaly: [l],
      });
      return;
    }
    const key = `New link|${l.src}|`;
    const open = this.alerts.find((x) => x.key === key && !x.acked && this.t - x.lastT < 300);
    const links = [...(open?.anomaly ?? []).filter((x) => !(x.dst === l.dst && x.service === l.service && x.fc === l.fc)), l];
    // Writes to controllers first, then other Modbus, then the rest.
    const rank = (x: LinkObs) => (x.service === "modbus" ? (x.fc !== undefined && WRITE_FCS.includes(x.fc) ? 0 : 1) : 2);
    const sorted = [...links].sort((a, b) => rank(a) - rank(b));
    const shown = sorted.slice(0, 6).map((x) => linkText(x)).join("; ");
    const remote = links.some((x) => x.service === "rdp" || x.service === "ssh");
    this.raise({
      severity: toController || open?.severity === "high" ? "high" : "medium",
      title: "New link",
      detail: `${l.src}${src ? ` (${src.ip})` : ""} started ${links.length === 1 ? "a connection" : `${links.length} connections`} the sensor never saw while it learned this plant: ${shown}${links.length > 6 ? `, and ${links.length - 6} more (ids links --new)` : ""}.`,
      src: l.src,
      source: "ids",
      attack: remote ? ["T0886"] : undefined,
      advice: `If this is a planned change, learn it with ids learn ID. If nobody planned it, find out who uses ${l.src} and treat it as suspect.`,
      anomaly: links,
    });
  }

  private processAlarms(): void {
    const now = new Set<string>();
    for (const a of this.plant.alarms()) {
      now.add(a.id);
      if (!this.activeAlarms.has(a.id) && !this.plant.quietAlarms.includes(a.id)) {
        this.raise({ severity: a.severity, title: a.text, detail: this.plant.alarmDetail(a.id), source: "process" });
      }
    }
    this.activeAlarms = now;
  }

  raise(a: RaiseOptions): Alert {
    const key = `${a.title}|${a.src ?? ""}|${a.dst ?? ""}`;
    const existing = this.alerts.find((x) => x.key === key && !x.acked && this.t - x.lastT < 300);
    if (existing) {
      existing.count++;
      existing.lastT = this.t;
      existing.detail = a.detail;
      if (SEV_RANK[a.severity] > SEV_RANK[existing.severity]) existing.severity = a.severity;
      if (a.anomaly) existing.anomaly = a.anomaly;
      if (a.attack) existing.attack = [...new Set([...(existing.attack ?? []), ...a.attack])];
      return existing;
    }
    const alert: Alert = { id: `A-${++this.alertSeq}`, t: this.t, lastT: this.t, count: 1, acked: false, key, ...a };
    this.alerts.push(alert);
    if (this.alerts.length > 200) this.alerts.shift();
    return alert;
  }

  /** Accept what an anomaly alert saw as normal: add it to the sensor's baseline and close the alert. */
  learnAlert(id: string): Alert {
    const a = this.alerts.find((x) => x.id.toLowerCase() === id.toLowerCase());
    if (!a) throw new UserError(`no alert ${id}`);
    if (!a.anomaly?.length) throw new UserError(`${a.id} is not an anomaly alert, so there is nothing to learn. Acknowledge it with alerts ack ${a.id} once it is handled.`);
    this.sensor.learn(a.anomaly, "alert", this.t);
    a.acked = true;
    a.learned = true;
    this.emit();
    return a;
  }

  // ------------------------------------------------------------ views

  /** Flows the plant needs right now: not the other mode's flows, and not flows whose every path runs through a host that is out of action. */
  activeFlows(): SiteFlow[] {
    const up = (n: string) => !this.net.host(n)?.down;
    return this.site.flows.filter((f) => this.modeActive(f.when) && f.paths.some((p) => p.every((h) => up(h.from) && up(h.to))));
  }

  requiredFlows(): FlowStatus[] {
    return requiredFlowStatus(this.net, this.activeFlows());
  }

  /** Takeover flows while the main centre has control: would they work once their rules are enabled? */
  standbyFlows(): FlowStatus[] {
    if (this.takeover) return [];
    return requiredFlowStatus(this.net, this.site.flows.filter((f) => f.when === "takeover"), { withDisabled: true });
  }

  risks(): RiskCheck[] {
    return riskChecks(this.net, this.site, { takeover: this.takeover });
  }

  snapshot(): SimSnapshot {
    return {
      t: this.t,
      site: { id: this.site.id, name: this.site.name },
      plant: { model: this.plant.model, ...this.plant.snapshot(), alarms: this.plant.alarms() },
      hmi: { online: this.hmiOnline, lastPlc: this.site.hmi ? this.hmiLast[this.site.hmi.device] ?? 0 : 0, host: this.hmiHost },
      takeover: this.takeover,
      sensor: { mode: this.sensor.mode, baseline: this.sensor.baseline.length, assets: this.sensor.assets(this.net.hosts).length },
      ...this.net.toJSON(),
      required: this.requiredFlows().map((f) => ({ id: f.flow.id, title: f.flow.title, ok: f.ok, reason: f.reason })),
      risks: this.risks(),
      alerts: this.alerts.map((a) => ({ ...a })),
    };
  }
}

export interface SimSnapshot {
  t: number;
  site: { id: string; name: string };
  plant: { model: string; alarms: { id: string; text: string; severity: string }[] } & Record<string, unknown>;
  hmi: { online: boolean; lastPlc: number; host: string };
  takeover: boolean;
  sensor: { mode: string; baseline: number; assets: number };
  hosts: Host[];
  zones: Network["zones"];
  conduits: Network["conduits"];
  required: { id: string; title: string; ok: boolean; reason: string }[];
  risks: RiskCheck[];
  alerts: Alert[];
}

function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

export function describeRequest(req: ModbusRequest): string {
  const name = FC_NAMES[req.fc] ?? `function code ${req.fc}`;
  const what = req.fc === 5 || req.fc === 15 ? "coil" : req.fc === 6 || req.fc === 16 ? "holding register" : "";
  if (req.values && req.values.length) return `${name} (fc ${req.fc}): ${what} ${req.addr} = ${req.values.join(",")}`;
  return `${name} (fc ${req.fc})`;
}
