// The simulation: the plant process, the network policy, the background
// traffic the plant needs, a passive OT intrusion detection sensor, and the
// logs the learner investigates (flows, firewall log, alerts).
//
// Time is virtual. In the apps it follows the wall clock; lab checks and
// tests move it forward instantly with settle().

import { Plant, WRITE_FCS, FC_NAMES, type DeviceName, type ModbusReply, type ModbusRequest } from "./plant.js";
import { Network, type Host, type ServiceName, type Verdict } from "./network.js";
import { requiredFlowStatus, riskChecks, type FlowStatus, type RiskCheck } from "./checks.js";

export const STEP = 0.5;
/** Longest stretch of time the plant catches up on at once (e.g. after a laptop sleeps). */
const MAX_CATCH_UP = 600;

export interface SimOptions {
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

/** Hosts that are expected to write to plc-1 (the IDS baseline). */
export const BASELINE_WRITERS = ["hmi-01", "ews-01"];

export class Sim {
  readonly plant = new Plant();
  readonly net = new Network();
  /** Plant time in seconds since the simulation started. */
  t = 0;
  events: TrafficEvent[] = [];
  conversations = new Map<string, Conversation>();
  alerts: Alert[] = [];
  fwlog: FwLogEntry[] = [];
  /** Tank level every 5 seconds, for trends. */
  trend: { t: number; level: number; chlorine: number }[] = [];
  /** When the HMI last got fresh data from each controller. */
  hmiLast: Record<DeviceName, number> = { "plc-1": 0, "sis-1": 0 };
  /** Values the HMI shows (from its last successful poll). */
  hmiView = { level: 55, chlorine: 1.5, pump: false, dosing: true, auto: true, sisTrip: false, bypass: false };

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
    this.clock = opts.clock ?? (() => Date.now());
    this.realStart = this.clock();
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
      this.trend.push({ t: this.t, level: this.plant.level, chlorine: this.plant.chlorine });
      if (this.trend.length > 240) this.trend.shift();
    }
  }

  // ------------------------------------------------------------ background traffic

  private poll(src: string, dst: DeviceName, fcs: number[]): boolean {
    let ok = true;
    for (const fc of fcs) {
      const r = this.modbus(src, dst, { fc, addr: 0, count: fc === 1 ? 3 : fc === 2 ? 2 : 1 }, { background: true });
      ok &&= !!r.reply?.ok;
    }
    return ok;
  }

  private backgroundTraffic(): void {
    if (this.every("hmi-plc", 2, 1)) {
      if (this.poll("hmi-01", "plc-1", [3, 4])) {
        this.hmiLast["plc-1"] = this.t;
        const p = this.plant;
        Object.assign(this.hmiView, { level: p.level, chlorine: p.chlorine, pump: p.pumpRunning, dosing: p.dosingRunning, auto: p.autoMode });
      }
    }
    if (this.every("hmi-sis", 5, 2)) {
      if (this.poll("hmi-01", "sis-1", [2])) {
        this.hmiLast["sis-1"] = this.t;
        Object.assign(this.hmiView, { sisTrip: this.plant.sisTrip, bypass: this.plant.bypassed });
      }
    }
    if (this.every("hist-plc", 5, 3)) this.poll("historian", "plc-1", [4]);
    if (this.every("hist-sis", 10, 4)) this.poll("historian", "sis-1", [4]);
    if (this.every("replica", 10, 5)) this.send("historian", "hist-dmz", "https", { background: true });
    if (this.every("reports", 30, 7)) this.send("corp-pc", "hist-dmz", "https", { background: true });

    const commOk = this.t - this.hmiLast["plc-1"] <= 6 || this.t < 6;
    if (!commOk && this.hmiCommOk) this.raise({ severity: "medium", title: "HMI lost communication with plc-1", detail: "hmi-01 has had no answer from plc-1 for more than 6 seconds. Operators are blind.", src: "hmi-01", dst: "plc-1", source: "process" });
    this.hmiCommOk = commOk;
  }

  get hmiOnline(): boolean {
    return this.hmiCommOk;
  }

  // ------------------------------------------------------------ traffic

  /** Send one request through the network policy and record it. */
  send(srcRef: string, dstRef: string, service: ServiceName, opts: { fc?: number; background?: boolean; detail?: string } = {}): Verdict {
    const src = this.net.needHost(srcRef);
    const dst = this.net.needHost(dstRef);
    const v = this.net.evaluate(src, dst, service, opts.fc, { count: true });
    const background = !!opts.background;
    this.events.push({ seq: ++this.seq, t: this.t, src: src.name, dst: dst.name, service, fc: opts.fc, allowed: v.allowed, delivered: v.delivered, reason: v.reason, conduit: v.conduit, background });
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
    const detail = describeRequest(req);
    const verdict = this.send(srcRef, dst.name, "modbus", { fc: req.fc, background: opts.background, detail });
    if (!verdict.delivered) return { verdict };
    if (dst.name !== "plc-1" && dst.name !== "sis-1") return { verdict };
    return { verdict, reply: this.plant.modbus(dst.name, req) };
  }

  // ------------------------------------------------------------ detection

  /** The passive IDS sensor: it sees traffic that made it through the firewalls. */
  private inspect(src: Host, dst: Host, service: ServiceName, v: Verdict, fc: number | undefined, detail: string | undefined, background: boolean): void {
    if (background) return;
    if (service === "modbus" && fc !== undefined && WRITE_FCS.includes(fc)) {
      if (dst.name === "sis-1") {
        this.raise({ severity: "critical", title: "Modbus write to the safety system", detail: `${src.name} (${src.ip}) sent ${detail ?? `function code ${fc}`} to sis-1. Safety systems should never be written to over the plant network.`, src: src.name, dst: dst.name, source: "ids" });
      } else if (dst.name === "plc-1" && !BASELINE_WRITERS.includes(src.name)) {
        this.raise({ severity: "high", title: "Unauthorized Modbus write to plc-1", detail: `${src.ip} sent ${detail ?? `function code ${fc}`} to plc-1. Only hmi-01 and ews-01 normally write to this PLC.`, src: src.name, dst: dst.name, source: "ids" });
      }
    }
    if (service === "modbus" && fc === 43 && src.name !== "ews-01") {
      this.raise({ severity: "low", title: "Modbus device identification read", detail: `${src.ip} asked ${dst.name} for its vendor, model and firmware (function code 43). This is typical reconnaissance.`, src: src.name, dst: dst.name, source: "ids" });
    }
    if ((service === "rdp" || service === "ssh") && src.level >= 5 && dst.level <= 3) {
      this.raise({ severity: "high", title: "Remote access from the internet into the plant", detail: `${src.name} (${src.ip}) opened ${service} straight to ${dst.name}, a plant host, with no DMZ in between.`, src: src.name, dst: dst.name, source: "ids" });
    }
    if (v.allowed) {
      const port = service === "icmp" ? "icmp" : String(service);
      const list = (this.scans.get(src.name) ?? []).filter((x) => this.t - x.t <= 30);
      const target = `${dst.name}:${port}`;
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
      if (!this.activeAlarms.has(a.id) && a.id !== "level-h" && a.id !== "level-l" && a.id !== "manual") {
        this.raise({ severity: a.severity, title: a.text, detail: processDetail(a.id, this), source: "process" });
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
    return requiredFlowStatus(this.net);
  }

  risks(): RiskCheck[] {
    return riskChecks(this.net);
  }

  snapshot(): SimSnapshot {
    const p = this.plant;
    return {
      t: this.t,
      plant: {
        level: round(p.level, 1),
        chlorine: round(p.chlorine, 2),
        pumpRunning: p.pumpRunning,
        dosingRunning: p.dosingRunning,
        autoMode: p.autoMode,
        sisTrip: p.sisTrip,
        bypassed: p.bypassed,
        overflowing: p.overflowing,
        overflowSeconds: round(p.overflowSeconds, 1),
        startLevel: p.plcHr[0],
        stopLevel: p.plcHr[1],
        chlorineSetpoint: p.plcHr[2],
        tripLevel: p.sisHr[0],
        alarms: p.alarms(),
      },
      hmi: { online: this.hmiOnline, view: { ...this.hmiView }, lastPlc: this.hmiLast["plc-1"] },
      ...this.net.toJSON(),
      required: this.requiredFlows().map((f) => ({ id: f.flow.id, title: f.flow.title, ok: f.ok, reason: f.reason })),
      risks: this.risks(),
      alerts: this.alerts.map((a) => ({ ...a })),
    };
  }
}

export interface SimSnapshot {
  t: number;
  plant: {
    level: number;
    chlorine: number;
    pumpRunning: boolean;
    dosingRunning: boolean;
    autoMode: boolean;
    sisTrip: boolean;
    bypassed: boolean;
    overflowing: boolean;
    overflowSeconds: number;
    startLevel: number;
    stopLevel: number;
    chlorineSetpoint: number;
    tripLevel: number;
    alarms: { id: string; text: string; severity: string }[];
  };
  hmi: { online: boolean; view: Sim["hmiView"]; lastPlc: number };
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

function processDetail(id: string, sim: Sim): string {
  const p = sim.plant;
  switch (id) {
    case "overflow":
      return `The tank is full and the inlet pump keeps running. Auto mode: ${p.autoMode ? "on" : "off"}, SIS bypass: ${p.bypassed ? "on" : "off"}, stop level ${p.plcHr[1] / 10} %.`;
    case "level-hh":
      return `Level ${p.level.toFixed(1)} %. The safety system trips at ${p.sisHr[0] / 10} %${p.bypassed ? ", but its trip is bypassed" : ""}.`;
    case "sis-trip":
      return "sis-1 stopped inlet pump P-101 on high-high level. It resets when the level falls below 80 %.";
    case "sis-bypass":
      return "The high-high trip is bypassed (sis-1 coil 0 = 1). Nothing stops the tank from overflowing if the PLC fails.";
    case "cl-low":
      return `Chlorine residual is ${p.chlorine.toFixed(2)} mg/L, below 0.5 mg/L. Dosing ${p.dosingRunning ? "on" : "off"}, setpoint ${(p.plcHr[2] / 100).toFixed(2)} mg/L.`;
    case "cl-high":
      return `Chlorine residual is ${p.chlorine.toFixed(2)} mg/L, above 4 mg/L. Setpoint ${(p.plcHr[2] / 100).toFixed(2)} mg/L.`;
    default:
      return "";
  }
}
