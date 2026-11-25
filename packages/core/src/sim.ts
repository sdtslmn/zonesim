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
import type { Site } from "./site.js";

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
}

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
    this.site.polling.forEach((p, i) => {
      if (!this.every(`poll-${i}`, p.every, i + 1)) return;
      if (p.service !== "modbus") {
        this.send(p.from, p.to, p.service as ServiceName, { background: true });
        return;
      }
      let ok = true;
      for (const fc of p.fc ?? [3]) {
        const r = this.modbus(p.from, p.to, { fc, addr: 0, count: 1 }, { background: true });
        ok &&= !!r.verdict.delivered;
      }
      if (ok && hmi && p.from === hmi.host) {
        this.hmiLast[p.to] = this.t;
        const dev = this.devices.get(p.to);
        if (dev) for (const t of ["coil", "di", "ir", "hr"] as const) for (const pt of dev.def.points[t]) this.hmiValues[pt.signal] = this.plant.get(pt.signal);
      }
    });
    if (hmi) {
      const commOk = this.t < hmi.timeout || this.t - (this.hmiLast[hmi.device] ?? 0) <= hmi.timeout;
      if (!commOk && this.hmiCommOk) this.raise({ severity: "medium", title: `HMI lost communication with ${hmi.device}`, detail: `${hmi.host} has had no answer from ${hmi.device} for more than ${hmi.timeout} seconds. Operators are blind.`, src: hmi.host, dst: hmi.device, source: "process" });
      this.hmiCommOk = commOk;
    }
  }

  get hmiOnline(): boolean {
    return this.hmiCommOk;
  }

  /** Controllers the HMI polls, its own controller first. */
  hmiDevices(): string[] {
    const h = this.site.hmi;
    if (!h) return [];
    const polled = this.site.polling.filter((p) => p.from === h.host && p.service === "modbus" && this.devices.has(p.to)).map((p) => p.to);
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

  /** The point the HMI writes for a signal: a coil or holding register on the HMI's own controller. */
  hmiWritable(signal: string): HmiSource | undefined {
    const src = this.hmiSource(signal);
    return src && src.device === this.site.hmi?.device && (src.table === "coil" || src.table === "hr") ? src : undefined;
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
      const r = this.modbus(h.host, h.device, { fc, addr: point.addr, values: [value] });
      if (!r.verdict.delivered) action = { t: this.t, text, ok: false, result: `no response from ${h.device}`, detail: r.verdict.reason };
      else if (!r.reply?.ok) {
        const ex = r.reply?.exception;
        action = { t: this.t, text, ok: false, result: `${h.device} rejected it`, detail: ex !== undefined ? `Modbus exception ${ex} (${EXCEPTIONS[ex] ?? "unknown"})` : undefined };
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
    this.events.push({ seq: ++this.seq, t: this.t, src: src.name, dst: dst.name, service, fc: opts.fc, allowed: v.allowed, delivered: v.delivered, reason: v.reason, conduit: v.conduit, rule: v.rule, srcZone: src.zone, dstZone: dst.zone, background });
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
    return { verdict, reply: dev.modbus(req) };
  }

  // ------------------------------------------------------------ detection

  /** The passive IDS sensor: it sees traffic that made it through the firewalls. */
  private inspect(src: Host, dst: Host, service: ServiceName, v: Verdict, fc: number | undefined, detail: string | undefined, background: boolean): void {
    if (background) return;
    const ids = this.site.ids;
    if (service === "modbus" && fc !== undefined && WRITE_FCS.includes(fc) && this.devices.has(dst.name)) {
      if (ids.safety.includes(dst.name)) {
        this.raise({ severity: "critical", title: "Modbus write to the safety system", detail: `${src.name} (${src.ip}) sent ${detail ?? `function code ${fc}`} to ${dst.name}. Safety systems should never be written to over the plant network.`, src: src.name, dst: dst.name, source: "ids" });
      } else if (!(ids.writers[dst.name] ?? []).includes(src.name)) {
        const normal = ids.writers[dst.name]?.length ? `Only ${ids.writers[dst.name].join(" and ")} normally write to this controller.` : "Nothing normally writes to this controller.";
        this.raise({ severity: "high", title: `Unauthorized Modbus write to ${dst.name}`, detail: `${src.ip} sent ${detail ?? `function code ${fc}`} to ${dst.name}. ${normal}`, src: src.name, dst: dst.name, source: "ids" });
      }
    }
    if (service === "modbus" && fc === 43 && !ids.identify.includes(src.name)) {
      this.raise({ severity: "low", title: "Modbus device identification read", detail: `${src.ip} asked ${dst.name} for its vendor, model and firmware (function code 43). This is typical reconnaissance.`, src: src.name, dst: dst.name, source: "ids" });
    }
    if ((service === "rdp" || service === "ssh") && src.level >= 5 && dst.level <= 3) {
      this.raise({ severity: "high", title: "Remote access from the internet into the plant", detail: `${src.name} (${src.ip}) opened ${service} straight to ${dst.name}, a plant host, with no DMZ in between.`, src: src.name, dst: dst.name, source: "ids" });
    }
    if (v.allowed) {
      const list = (this.scans.get(src.name) ?? []).filter((x) => this.t - x.t <= 30);
      const target = `${dst.name}:${service}`;
      if (!list.some((x) => x.target === target)) list.push({ t: this.t, target });
      this.scans.set(src.name, list);
      if (list.length >= 8) {
        this.raise({ severity: "medium", title: "Network scan", detail: `${src.name} (${src.ip}) probed ${list.length} host and port pairs in 30 seconds.`, src: src.name, source: "ids" });
        this.scans.set(src.name, []);
      }
    }
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

  raise(a: { severity: Severity; title: string; detail: string; src?: string; dst?: string; source: "ids" | "process" }): Alert {
    const key = `${a.title}|${a.src ?? ""}|${a.dst ?? ""}`;
    const existing = this.alerts.find((x) => x.key === key && !x.acked && this.t - x.lastT < 300);
    if (existing) {
      existing.count++;
      existing.lastT = this.t;
      existing.detail = a.detail;
      return existing;
    }
    const alert: Alert = { id: `A-${++this.alertSeq}`, t: this.t, lastT: this.t, count: 1, acked: false, key, ...a };
    this.alerts.push(alert);
    if (this.alerts.length > 200) this.alerts.shift();
    return alert;
  }

  // ------------------------------------------------------------ views

  requiredFlows(): FlowStatus[] {
    return requiredFlowStatus(this.net, this.site.flows);
  }

  risks(): RiskCheck[] {
    return riskChecks(this.net, this.site);
  }

  snapshot(): SimSnapshot {
    return {
      t: this.t,
      site: { id: this.site.id, name: this.site.name },
      plant: { model: this.plant.model, ...this.plant.snapshot(), alarms: this.plant.alarms() },
      hmi: { online: this.hmiOnline, lastPlc: this.site.hmi ? this.hmiLast[this.site.hmi.device] ?? 0 : 0 },
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
  hmi: { online: boolean; lastPlc: number };
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
