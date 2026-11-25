// The "gas-compressor" process model: a pipeline compressor station.
//
//   upstream line ──► compressor K-101 ──► SDV-102 ──► downstream line (customers)
//                       ▲          │
//                       └─ UV-101 ◄┘  anti-surge recycle
//
// The unit PLC runs the compressor speed to hold the discharge pressure, and
// an anti-surge controller opens the recycle valve when the flow through the
// compressor gets close to its surge line. The safety system (ESD) trips the
// compressor and closes the station valve on high-high discharge pressure. A
// relief valve vents gas to atmosphere if the pressure keeps rising. A flow
// computer measures the gas sold downstream.
//
// The physics are deliberately simple. Flows are fractions of the design flow:
// at speed s the compressor can push up to s, less as the discharge pressure
// approaches what that speed can make (suction + headMax * s²). It surges when
// the flow through it falls below surgeLine * s.

import type { PlantAlarm, ProcessModel, ProcessModelType, ParamSpec, SignalSpec, Readout, TrendSpec } from "./model.js";

const PARAMS: ParamSpec[] = [
  { name: "suctionPressure", default: 40, min: 1, max: 200, description: "Upstream (suction) pressure, bar" },
  { name: "headMax", default: 70, min: 5, max: 300, description: "Pressure the compressor adds at full speed and no flow, bar" },
  { name: "setpoint", default: 65, min: 1, max: 300, description: "Default discharge pressure setpoint, bar" },
  { name: "demand", default: 35, min: 1, max: 100, description: "Gas the downstream customers take, % of design flow" },
  { name: "designFlow", default: 400, min: 1, max: 100000, description: "Design flow, thousand standard m³ per hour" },
  { name: "lowAlarm", default: 50, min: 0, max: 300, description: "Downstream pressure low alarm, bar" },
  { name: "highAlarm", default: 70, min: 0, max: 300, description: "Discharge pressure high alarm, bar" },
  { name: "tripPressure", default: 75, min: 0, max: 300, description: "Default safety trip pressure (PSHH), bar" },
  { name: "tripReset", default: 68, min: 0, max: 300, description: "The safety trip resets below this pressure, bar" },
  { name: "reliefPressure", default: 80, min: 0, max: 300, description: "Relief valve set pressure, bar" },
  { name: "surgeLine", default: 55, min: 1, max: 99, description: "Minimum flow through the compressor, % of what its speed can push" },
  { name: "surgeMargin", default: 15, min: 1, max: 100, description: "Margin the anti-surge controller keeps above the surge line, %" },
  { name: "pressureRate", default: 0.5, min: 0.01, max: 20, description: "Pressure change per second at a 100 % flow imbalance, bar" },
  { name: "speedRate", default: 2, min: 0.1, max: 100, description: "How fast the speed can change, % per second" },
  { name: "vibrationTrip", default: 10, min: 1, max: 600, description: "Seconds of surge before the compressor trips on vibration" },
];

const SIGNALS: SignalSpec[] = [
  { name: "compressor.run", type: "bool", writable: true, description: "Compressor run command" },
  { name: "control.auto", type: "bool", writable: true, description: "1 = speed holds the discharge pressure setpoint, 0 = manual speed" },
  { name: "antisurge.auto", type: "bool", writable: true, description: "1 = anti-surge controller in auto, 0 = manual recycle valve" },
  { name: "sis.bypass", type: "bool", writable: true, description: "Bypass of the high-high pressure trip" },
  { name: "setpoint.discharge", type: "int", writable: true, description: "Discharge pressure setpoint, tenths of a bar" },
  { name: "setpoint.speed", type: "int", writable: true, description: "Manual speed, tenths of a %" },
  { name: "setpoint.recycle", type: "int", writable: true, description: "Manual recycle valve position, tenths of a %" },
  { name: "sis.trip_pressure", type: "int", writable: true, description: "High-high pressure trip, tenths of a bar" },
  { name: "meter.factor", type: "int", writable: true, description: "Flow computer meter factor, 10000 = 1.0000" },
  { name: "compressor.running", type: "bool", writable: false, description: "Compressor is running" },
  { name: "alarm.surge", type: "bool", writable: false, description: "Compressor in surge" },
  { name: "alarm.high_pressure", type: "bool", writable: false, description: "Discharge pressure high" },
  { name: "alarm.venting", type: "bool", writable: false, description: "Relief valve lifting, gas venting" },
  { name: "sis.tripped", type: "bool", writable: false, description: "Safety trip active" },
  { name: "sis.bypassed", type: "bool", writable: false, description: "Safety trip is bypassed" },
  { name: "valve.esd_closed", type: "bool", writable: false, description: "Station ESD valve is closed" },
  { name: "pressure.suction", type: "int", writable: false, description: "Suction pressure, tenths of a bar" },
  { name: "pressure.discharge", type: "int", writable: false, description: "Discharge pressure, tenths of a bar" },
  { name: "speed", type: "int", writable: false, description: "Compressor speed, tenths of a %" },
  { name: "recycle", type: "int", writable: false, description: "Recycle valve position, tenths of a %" },
  { name: "flow", type: "int", writable: false, description: "Station flow, thousand Sm³/h" },
  { name: "surge.margin", type: "int", writable: false, description: "Distance from the surge line, % (0 when in surge)" },
  { name: "sis.pressure", type: "int", writable: false, description: "Independent discharge pressure, tenths of a bar" },
  { name: "meter.flow", type: "int", writable: false, description: "Flow measured by the flow computer, thousand Sm³/h" },
];

const TAGS = { compressor: "K-101", recycle: "UV-101", esd: "SDV-102", relief: "PSV-103", meter: "FQ-104", source: "upstream line", consumer: "downstream line" };

/** Share of the compressor's flow the fully open recycle valve can return. */
const RECYCLE_CAP = 0.8;
/** Flow from upstream straight through the station when the compressor is stopped, per bar of difference. */
const BYPASS_K = 0.05;

export class GasCompressor implements ProcessModel {
  readonly model = "gas-compressor";
  readonly quietAlarms = ["pd-h", "manual", "stopped"];
  readonly headline = "discharge";
  readonly trends: TrendSpec[] = [
    { signal: "pressure.discharge", label: "Discharge pressure", scale: 0.1, max: 100 },
    { signal: "surge.margin", label: "Surge margin", scale: 1, max: 100 },
  ];

  /** Discharge pressure (bar), speed (0 to 1), recycle valve (0 to 100 %). */
  pd: number;
  speed: number;
  recycle: number;
  running = true;
  sisTrip = false;
  surging = false;
  surgeTimer = 0;
  surgeSeconds = 0;
  vibrationTrip = false;
  private vibrationTimer = 0;
  ventSeconds = 0;
  venting = false;
  private integral: number;
  flow = 0;
  margin = 100;

  runCommand = true;
  autoMode = true;
  antisurgeAuto = true;
  bypass = false;
  dischargeSp: number;
  speedSp: number;
  recycleSp = 0;
  tripSp: number;
  meterFactor = 10000;

  constructor(
    readonly params: Record<string, number>,
    readonly tags: Record<string, string>,
  ) {
    const p = params;
    const d = p.demand / 100;
    this.pd = p.setpoint;
    this.dischargeSp = Math.round(p.setpoint * 10);
    this.tripSp = Math.round(p.tripPressure * 10);
    // Start at the steady state: the speed that holds the setpoint at this demand.
    this.speed = Math.min(1, Math.sqrt(Math.max(0, (p.setpoint - p.suctionPressure) / p.headMax + d * d)));
    this.speedSp = Math.round(this.speed * 1000);
    this.integral = this.speed;
    this.recycle = this.recycleNeeded(this.speed, d);
    this.flow = d;
  }

  private forwardFlow(s: number, pd: number): number {
    const p = this.params;
    if (s <= 0.01) return 0;
    const ratio = (pd - p.suctionPressure) / (p.headMax * s * s);
    if (ratio <= 0) return s;
    if (ratio >= 1) return 0;
    return s * Math.sqrt(1 - ratio);
  }

  private recycleNeeded(s: number, forward: number): number {
    const p = this.params;
    if (s <= 0.01) return 0;
    const target = (1 + p.surgeMargin / 100) * (p.surgeLine / 100) * s;
    const need = Math.max(0, target - forward);
    return Math.min(100, (need / (s * RECYCLE_CAP)) * 100);
  }

  get esdClosed(): boolean {
    return this.sisTrip;
  }

  get bypassed(): boolean {
    return this.bypass;
  }

  step(dt: number): void {
    const p = this.params;

    // Safety system: trips on high-high pressure, resets with hysteresis.
    // A trip also drops the run command: an operator restarts the compressor.
    if (this.bypass) this.sisTrip = false;
    else if (this.pd * 10 >= this.tripSp) {
      if (!this.sisTrip) this.runCommand = false;
      this.sisTrip = true;
    } else if (this.sisTrip && this.pd <= p.tripReset) this.sisTrip = false;

    if (this.vibrationTrip) {
      this.vibrationTimer -= dt;
      if (this.vibrationTimer <= 0) this.vibrationTrip = false;
    }
    this.running = this.runCommand && !this.sisTrip && !this.vibrationTrip;

    // Speed: auto holds the discharge pressure, manual follows the setpoint.
    // Auto is a PI controller on the discharge pressure.
    let target = 0;
    if (this.running) {
      if (this.autoMode) {
        const err = this.dischargeSp / 10 - this.pd;
        this.integral = Math.max(0.3, Math.min(1, this.integral + 0.0015 * err * dt));
        target = this.integral + 0.05 * err;
      } else {
        target = this.speedSp / 1000;
        this.integral = this.speed;
      }
    } else this.integral = 0.3;
    target = Math.max(this.running ? 0.3 : 0, Math.min(1, target));
    const maxStep = (p.speedRate / 100) * dt * (this.running ? 1 : 5);
    this.speed += Math.max(-maxStep, Math.min(maxStep, target - this.speed));
    if (!this.running && this.speed < 0.01) this.speed = 0;
    const s = this.speed;

    // Flows through the compressor and the station.
    const forward = this.running ? this.forwardFlow(s, this.pd) : 0;
    const wanted = this.antisurgeAuto ? (s < 0.3 ? 100 : this.recycleNeeded(s, forward)) : this.recycleSp / 10;
    const open = wanted > this.recycle ? 25 : 3; // the valve opens fast and closes slowly
    this.recycle += Math.max(-open * dt, Math.min(open * dt, wanted - this.recycle));
    this.recycle = Math.max(0, Math.min(100, this.recycle));
    const recycled = s * RECYCLE_CAP * (this.recycle / 100);
    const through = forward + recycled;
    const surgeFlow = (p.surgeLine / 100) * s;
    this.margin = this.running && surgeFlow > 0 ? (through / surgeFlow - 1) * 100 : 100;
    // Below 30 % speed (starting or stopping) the recycle valve is held open and surge is not counted.
    this.surging = this.running && s >= 0.3 && through < surgeFlow;
    if (this.surging) {
      this.surgeTimer += dt;
      this.surgeSeconds += dt;
      if (this.surgeTimer >= p.vibrationTrip) {
        this.vibrationTrip = true;
        this.runCommand = false;
        this.vibrationTimer = 60;
        this.surgeTimer = 0;
      }
    } else this.surgeTimer = Math.max(0, this.surgeTimer - dt);

    // The downstream line: in from the station, out to the customers and the relief valve.
    const stationOpen = !this.esdClosed;
    const bypassFlow = stationOpen && !this.running && this.pd < p.suctionPressure ? BYPASS_K * (p.suctionPressure - this.pd) : 0;
    const inflow = stationOpen ? forward + bypassFlow : 0;
    const demand = (p.demand / 100) * Math.min(1, this.pd / Math.max(1, p.lowAlarm));
    this.venting = this.pd >= p.reliefPressure;
    const relief = this.venting ? (this.pd - p.reliefPressure + 0.2) * 2 : 0;
    this.pd = Math.max(0, this.pd + p.pressureRate * (inflow - demand - relief) * dt);
    if (this.venting) this.ventSeconds += dt;
    this.flow = inflow;
  }

  get(signal: string): number {
    const b = (v: boolean) => (v ? 1 : 0);
    const p = this.params;
    switch (signal) {
      case "compressor.run":
        return b(this.runCommand);
      case "control.auto":
        return b(this.autoMode);
      case "antisurge.auto":
        return b(this.antisurgeAuto);
      case "sis.bypass":
        return b(this.bypass);
      case "setpoint.discharge":
        return this.dischargeSp;
      case "setpoint.speed":
        return this.speedSp;
      case "setpoint.recycle":
        return this.recycleSp;
      case "sis.trip_pressure":
        return this.tripSp;
      case "meter.factor":
        return this.meterFactor;
      case "compressor.running":
        return b(this.running);
      case "alarm.surge":
        return b(this.surging);
      case "alarm.high_pressure":
        return b(this.pd >= p.highAlarm);
      case "alarm.venting":
        return b(this.venting);
      case "sis.tripped":
        return b(this.sisTrip);
      case "sis.bypassed":
        return b(this.bypass);
      case "valve.esd_closed":
        return b(this.esdClosed);
      case "pressure.suction":
        return Math.round(p.suctionPressure * 10);
      case "pressure.discharge":
      case "sis.pressure":
        return Math.round(this.pd * 10);
      case "speed":
        return Math.round(this.speed * 1000);
      case "recycle":
        return Math.round(this.recycle * 10);
      case "flow":
        return Math.round(this.flow * p.designFlow);
      case "surge.margin":
        return Math.max(0, Math.min(999, Math.round(this.margin)));
      case "meter.flow":
        return Math.round((this.flow * p.designFlow * this.meterFactor) / 10000);
      default:
        return NaN;
    }
  }

  set(signal: string, value: number): boolean {
    const on = value === 1;
    switch (signal) {
      case "compressor.run":
        this.runCommand = on;
        return true;
      case "control.auto":
        if (on && !this.autoMode) this.speedSp = Math.round(this.speed * 1000);
        this.autoMode = on;
        return true;
      case "antisurge.auto":
        if (!on && this.antisurgeAuto) this.recycleSp = Math.round(this.recycle * 10);
        this.antisurgeAuto = on;
        return true;
      case "sis.bypass":
        this.bypass = on;
        return true;
      case "setpoint.discharge":
        this.dischargeSp = value;
        return true;
      case "setpoint.speed":
        this.speedSp = Math.min(1000, value);
        return true;
      case "setpoint.recycle":
        this.recycleSp = Math.min(1000, value);
        return true;
      case "sis.trip_pressure":
        this.tripSp = value;
        return true;
      case "meter.factor":
        this.meterFactor = value;
        return true;
      default:
        return false;
    }
  }

  alarms(): PlantAlarm[] {
    const p = this.params;
    const t = this.tags;
    const out: PlantAlarm[] = [];
    if (this.venting) out.push({ id: "venting", text: `Relief valve ${t.relief} lifting: gas venting to atmosphere`, severity: "critical" });
    else if (this.pd >= this.tripSp / 10) out.push({ id: "pd-hh", text: "Discharge pressure high-high", severity: "critical" });
    else if (this.pd >= p.highAlarm) out.push({ id: "pd-h", text: "Discharge pressure high", severity: "medium" });
    if (this.pd <= p.lowAlarm) out.push({ id: "pd-l", text: "Downstream pressure low: customers losing supply", severity: "high" });
    if (this.surging) out.push({ id: "surge", text: `Compressor ${t.compressor} in surge`, severity: "critical" });
    if (this.vibrationTrip) out.push({ id: "vib-trip", text: `Compressor ${t.compressor} tripped on high vibration`, severity: "high" });
    if (this.sisTrip) out.push({ id: "sis-trip", text: `Safety trip: ${t.compressor} stopped, ${t.esd} closed`, severity: "high" });
    if (this.bypass) out.push({ id: "sis-bypass", text: "High-high pressure trip is bypassed", severity: "high" });
    if (!this.antisurgeAuto) out.push({ id: "antisurge-manual", text: `Anti-surge valve ${t.recycle} in manual`, severity: "medium" });
    if (!this.autoMode) out.push({ id: "manual", text: "Compressor speed in manual", severity: "low" });
    if (!this.runCommand) out.push({ id: "stopped", text: `Compressor ${t.compressor} stopped by command`, severity: "low" });
    return out;
  }

  readouts(get: (signal: string) => number, ctx: { safety?: string }): Readout[] {
    const p = this.params;
    const t = this.tags;
    const pd = get("pressure.discharge") / 10;
    const running = get("compressor.running") === 1;
    const auto = get("control.auto") === 1;
    const asAuto = get("antisurge.auto") === 1;
    const surge = get("alarm.surge") === 1;
    const venting = get("alarm.venting") === 1;
    const trip = get("sis.tripped") === 1;
    const bypass = get("sis.bypassed") === 1;
    const margin = get("surge.margin");
    const tripAt = get("sis.trip_pressure") / 10;
    const flow = get("flow");
    const meter = get("meter.flow");
    return [
      { id: "discharge", label: "Discharge pressure", text: `${pd.toFixed(1)} bar`, bar: (pd / p.reliefPressure) * 100, note: `setpoint ${(get("setpoint.discharge") / 10).toFixed(1)} bar`, state: venting ? "bad" : pd >= p.highAlarm || pd <= p.lowAlarm ? "warn" : "ok", strip: `Pd ${pd.toFixed(1)} bar`, hmi: true },
      { id: "suction", label: "Suction pressure", text: `${(get("pressure.suction") / 10).toFixed(1)} bar`, state: "ok", hmi: true },
      { id: "compressor", label: `Compressor ${t.compressor}`, text: running ? `running ${(get("speed") / 10).toFixed(0)} %` : "stopped", note: auto ? "auto" : "MANUAL speed", state: running ? (auto ? "ok" : "warn") : "bad", strip: `${t.compressor} ${running ? "running" : "stopped"}${auto ? "" : " (manual)"}`, hmi: true },
      { id: "antisurge", label: `Anti-surge valve ${t.recycle}`, text: `${(get("recycle") / 10).toFixed(0)} % open`, note: `${asAuto ? "auto" : "MANUAL"}, surge margin ${margin} %`, state: surge ? "bad" : !asAuto ? "warn" : "ok", strip: surge ? "SURGE" : `Surge margin ${margin} %`, hmi: true },
      { id: "flow", label: "Station flow", text: `${flow} kSm³/h`, state: flow > 0 ? "ok" : "warn", hmi: true },
      { id: "meter", label: `Flow computer ${t.meter}`, text: Number.isNaN(meter) ? "no data" : `${meter} kSm³/h`, note: `meter factor ${(get("meter.factor") / 10000).toFixed(4)}`, state: "ok" },
      { id: "sis", label: `Safety system${ctx.safety ? ` ${ctx.safety}` : ""}`, text: bypass ? "BYPASSED" : trip ? `TRIPPED, ${t.esd} closed` : "armed", note: `trips at ${tripAt.toFixed(1)} bar`, state: bypass ? "bad" : trip ? "warn" : "ok", strip: bypass ? "ESD bypassed" : trip ? "ESD tripped" : "ESD armed", hmi: true },
    ];
  }

  notes(): string[] {
    const out: string[] = [];
    if (this.ventSeconds > 0) out.push(`Gas vented to atmosphere for ${Math.round(this.ventSeconds)} s so far`);
    if (this.surgeSeconds > 0) out.push(`Compressor in surge for ${Math.round(this.surgeSeconds)} s so far: each surge cycle damages it`);
    return out;
  }

  alarmDetail(id: string): string {
    const p = this.params;
    const t = this.tags;
    switch (id) {
      case "venting":
        return `Discharge pressure ${this.pd.toFixed(1)} bar reached the relief valve set pressure of ${p.reliefPressure} bar. Gas is venting to atmosphere: a fire and explosion hazard. Speed ${this.autoMode ? "auto" : "manual"}, safety trip ${this.bypass ? "bypassed" : "armed"}.`;
      case "pd-hh":
        return `Discharge pressure ${this.pd.toFixed(1)} bar. The safety system trips at ${this.tripSp / 10} bar${this.bypass ? ", but its trip is bypassed" : ""}.`;
      case "pd-l":
        return `Downstream pressure ${this.pd.toFixed(1)} bar, below ${p.lowAlarm} bar. Customers are getting less gas than they need. Compressor ${this.running ? "running" : "stopped"}, ${t.esd} ${this.esdClosed ? "closed" : "open"}.`;
      case "surge":
        return `The flow through ${t.compressor} fell below its surge line. Gas flows backwards through the machine in violent cycles. Anti-surge ${this.antisurgeAuto ? "auto" : "manual"}, recycle valve ${this.recycle.toFixed(0)} % open.`;
      case "vib-trip":
        return `Machine protection stopped ${t.compressor} after ${p.vibrationTrip} s of surge. An operator can restart it after about a minute, once the cause is fixed.`;
      case "sis-trip":
        return `The safety system stopped ${t.compressor} and closed ${t.esd} on high-high discharge pressure. It resets below ${p.tripReset} bar, and then an operator restarts the compressor. Until then the station sends no gas downstream.`;
      case "sis-bypass":
        return "The high-high pressure trip is bypassed. If the pressure keeps rising, only the relief valve stands between the line and its design limit.";
      case "antisurge-manual":
        return `The anti-surge controller is in manual and ${t.recycle} sits at ${(this.recycleSp / 10).toFixed(0)} %. Nothing protects ${t.compressor} from surge if the flow drops.`;
      default:
        return "";
    }
  }

  snapshot(): Record<string, number | boolean> {
    const r = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
    return {
      dischargePressure: r(this.pd, 1),
      speed: r(this.speed * 100, 1),
      recycle: r(this.recycle, 1),
      flow: this.get("flow"),
      meterFlow: this.get("meter.flow"),
      meterFactor: this.meterFactor,
      surgeMargin: r(this.margin, 1),
      surging: this.surging,
      surgeSeconds: r(this.surgeSeconds, 1),
      vibrationTrip: this.vibrationTrip,
      venting: this.venting,
      ventSeconds: r(this.ventSeconds, 1),
      running: this.running,
      autoMode: this.autoMode,
      antisurgeAuto: this.antisurgeAuto,
      sisTrip: this.sisTrip,
      bypassed: this.bypass,
      esdClosed: this.esdClosed,
      dischargeSetpoint: this.dischargeSp,
      tripPressure: this.tripSp,
    };
  }
}

export const GAS_COMPRESSOR: ProcessModelType = {
  model: "gas-compressor",
  description: "A pipeline compressor station with discharge pressure control, anti-surge recycle, a safety trip, a relief valve and a flow computer.",
  signals: SIGNALS,
  params: PARAMS,
  tags: TAGS,
  check(p) {
    const e: string[] = [];
    if (!(p.tripReset < p.tripPressure && p.tripPressure < p.reliefPressure)) e.push("pressures must be in order: tripReset < tripPressure < reliefPressure");
    if (!(p.lowAlarm < p.setpoint && p.setpoint < p.highAlarm && p.highAlarm <= p.tripPressure)) e.push("pressures must be in order: lowAlarm < setpoint < highAlarm <= tripPressure");
    const d = p.demand / 100;
    if (p.suctionPressure + p.headMax * (1 - d * d) <= p.setpoint) e.push("the compressor cannot reach the setpoint at this demand: raise headMax or lower the setpoint or the demand");
    if (p.setpoint <= p.suctionPressure) e.push("setpoint must be above suctionPressure, or there is nothing to compress");
    return e;
  },
  create: (params, tags) => new GasCompressor(params, tags),
};
