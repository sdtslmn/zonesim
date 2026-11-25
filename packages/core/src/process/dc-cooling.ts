// The "dc-cooling" process model: cooling and power for one data hall.
//
//   chillers CH-1, CH-2 ──► chilled water (pumps CHWP-1) ──► CRAH units ──► cold aisle ──► servers
//
// The chiller plant controller runs one chiller and keeps the other as a
// spare (N+1), holds the chilled water supply temperature, and the CRAH units
// hold the cold aisle at the supply air setpoint. Lose the chillers or the
// pumps and the hall heats up within minutes; past the shutdown temperature
// the servers turn themselves off. A power meter reports IT load, cooling
// power and PUE. The fire alarm and suppression panel is the life safety
// system: it can be isolated for maintenance, and it releases clean agent
// into the hall, which stops the hall.

import type { PlantAlarm, ProcessModel, ProcessModelType, ParamSpec, SignalSpec, Readout, TrendSpec } from "./model.js";

const PARAMS: ParamSpec[] = [
  { name: "itLoad", default: 1200, min: 1, max: 100000, description: "IT load of the hall, kW" },
  { name: "chillerCapacity", default: 1500, min: 1, max: 100000, description: "Cooling capacity of each chiller, kW" },
  { name: "chwSetpoint", default: 14, min: 4, max: 30, description: "Default chilled water supply setpoint, °C" },
  { name: "supplyAirSetpoint", default: 24, min: 10, max: 35, description: "Default CRAH supply air (cold aisle) setpoint, °C" },
  { name: "approach", default: 8, min: 1, max: 20, description: "How much warmer the cold aisle is than the chilled water at best, K" },
  { name: "recommendedMax", default: 27, min: 15, max: 45, description: "Top of the recommended server inlet range, °C" },
  { name: "allowableMax", default: 32, min: 15, max: 50, description: "Top of the allowable server inlet range, °C" },
  { name: "shutdownTemp", default: 35, min: 15, max: 60, description: "Servers shut down above this inlet temperature, °C" },
  { name: "warmingRate", default: 2, min: 0.1, max: 30, description: "Cold aisle warming with no cooling at full load, °C per minute" },
  { name: "chwRate", default: 1, min: 0.1, max: 30, description: "Chilled water warming with no chiller at full load, °C per minute" },
  { name: "shutdownLoad", default: 30, min: 0, max: 100, description: "IT load left after the thermal shutdown, %" },
];

const SIGNALS: SignalSpec[] = [
  { name: "chiller1.enable", type: "bool", writable: true, description: "Chiller 1 available for duty" },
  { name: "chiller2.enable", type: "bool", writable: true, description: "Chiller 2 available for duty" },
  { name: "pump.run", type: "bool", writable: true, description: "Chilled water pumps run command" },
  { name: "control.auto", type: "bool", writable: true, description: "1 = the controller runs the chillers it needs (N+1), 0 = every enabled chiller runs" },
  { name: "fire.isolate", type: "bool", writable: true, description: "Isolate (disable) the suppression release for maintenance" },
  { name: "fire.release", type: "bool", writable: true, description: "Manual release of the clean agent" },
  { name: "setpoint.chw", type: "int", writable: true, description: "Chilled water supply setpoint, tenths of a °C" },
  { name: "setpoint.supply_air", type: "int", writable: true, description: "CRAH supply air setpoint, tenths of a °C" },
  { name: "chiller1.running", type: "bool", writable: false, description: "Chiller 1 running" },
  { name: "chiller2.running", type: "bool", writable: false, description: "Chiller 2 running" },
  { name: "pump.running", type: "bool", writable: false, description: "Chilled water pumps running" },
  { name: "alarm.high_temp", type: "bool", writable: false, description: "Cold aisle above the recommended range" },
  { name: "alarm.critical_temp", type: "bool", writable: false, description: "Cold aisle above the allowable range" },
  { name: "fire.isolated", type: "bool", writable: false, description: "Suppression release isolated" },
  { name: "fire.alarm", type: "bool", writable: false, description: "Fire alarm active" },
  { name: "fire.discharged", type: "bool", writable: false, description: "Clean agent released" },
  { name: "temp.chw_supply", type: "int", writable: false, description: "Chilled water supply temperature, tenths of a °C" },
  { name: "temp.cold_aisle", type: "int", writable: false, description: "Cold aisle temperature, tenths of a °C" },
  { name: "load.it", type: "int", writable: false, description: "IT load, kW" },
  { name: "power.cooling", type: "int", writable: false, description: "Cooling power, kW" },
  { name: "pue", type: "int", writable: false, description: "Power usage effectiveness, hundredths (135 = 1.35)" },
  { name: "fire.temp", type: "int", writable: false, description: "Hall temperature at the fire panel's heat detectors, tenths of a °C" },
];

const TAGS = { hall: "Data hall 1", chiller1: "CH-1", chiller2: "CH-2", pump: "CHWP-1", crah: "CRAH units", agent: "clean agent" };

export class DcCooling implements ProcessModel {
  readonly model = "dc-cooling";
  readonly quietAlarms = ["redundancy", "manual"];
  readonly headline = "cold-aisle";
  readonly trends: TrendSpec[] = [
    { signal: "temp.cold_aisle", label: "Cold aisle", scale: 0.1, max: 40 },
    { signal: "temp.chw_supply", label: "Chilled water supply", scale: 0.1, max: 30 },
  ];

  coldAisle: number;
  chws: number;
  running1 = true;
  running2 = false;
  pumpRunning = true;
  itShutdown = false;
  released = false;
  overTempSeconds = 0;

  enable1 = true;
  enable2 = true;
  pumpCommand = true;
  autoMode = true;
  fireIsolated = false;
  releaseCommand = false;
  chwSp: number;
  supplySp: number;

  constructor(
    readonly params: Record<string, number>,
    readonly tags: Record<string, string>,
  ) {
    this.chwSp = Math.round(params.chwSetpoint * 10);
    this.supplySp = Math.round(params.supplyAirSetpoint * 10);
    this.chws = params.chwSetpoint;
    this.coldAisle = Math.max(params.supplyAirSetpoint, params.chwSetpoint + params.approach);
  }

  get load(): number {
    const p = this.params;
    if (this.released) return 0;
    return this.itShutdown ? (p.itLoad * p.shutdownLoad) / 100 : p.itLoad;
  }

  get capacity(): number {
    return ((this.running1 ? 1 : 0) + (this.running2 ? 1 : 0)) * this.params.chillerCapacity;
  }

  get coolingPower(): number {
    const p = this.params;
    const used = Math.min(this.load, this.capacity);
    const cop = 4 + 0.15 * (this.chwSp / 10 - 10);
    return Math.round(used / Math.max(1, cop) + (this.pumpRunning ? 30 : 0) + (!this.released ? 0.03 * p.itLoad : 0));
  }

  get pue(): number {
    const load = this.load;
    return load > 0 ? (load * 1.06 + this.coolingPower) / load : 0;
  }

  step(dt: number): void {
    const p = this.params;
    if (this.releaseCommand && !this.fireIsolated) this.released = true;
    this.pumpRunning = this.pumpCommand;

    // Chillers: N+1 in auto, every enabled one in manual. No flow, no chiller.
    const available = [this.enable1 ? 1 : 0, this.enable2 ? 2 : 0].filter((x) => x);
    let run: number[] = [];
    if (this.pumpRunning) {
      if (this.autoMode) {
        const need = this.load > p.chillerCapacity || this.chws > this.chwSp / 10 + 2 ? 2 : 1;
        run = available.slice(0, need);
      } else run = available;
    }
    this.running1 = run.includes(1);
    this.running2 = run.includes(2);

    // Chilled water loop.
    const load = this.load;
    if (this.capacity > 0 && this.capacity >= load) this.chws += (this.chwSp / 10 - this.chws) * Math.min(1, dt / 60);
    else this.chws += (Math.max(0, load - this.capacity) / p.itLoad) * (p.chwRate / 60) * dt;
    this.chws = Math.min(40, this.chws);

    // Hall air: the CRAH units need chilled water flowing (and stop if the agent is released).
    if (this.pumpRunning && !this.released) {
      const target = Math.max(this.supplySp / 10, this.chws + p.approach);
      this.coldAisle += (target - this.coldAisle) * Math.min(1, dt / 45);
    } else this.coldAisle += (load / p.itLoad) * (p.warmingRate / 60) * dt;
    this.coldAisle = Math.min(60, this.coldAisle);

    if (this.coldAisle >= p.shutdownTemp) this.itShutdown = true;
    else if (this.itShutdown && this.coldAisle <= p.recommendedMax) this.itShutdown = false;
    if (this.coldAisle > p.allowableMax) this.overTempSeconds += dt;
  }

  get(signal: string): number {
    const b = (v: boolean) => (v ? 1 : 0);
    const p = this.params;
    switch (signal) {
      case "chiller1.enable":
        return b(this.enable1);
      case "chiller2.enable":
        return b(this.enable2);
      case "pump.run":
        return b(this.pumpCommand);
      case "control.auto":
        return b(this.autoMode);
      case "fire.isolate":
      case "fire.isolated":
        return b(this.fireIsolated);
      case "fire.release":
        return b(this.releaseCommand);
      case "setpoint.chw":
        return this.chwSp;
      case "setpoint.supply_air":
        return this.supplySp;
      case "chiller1.running":
        return b(this.running1);
      case "chiller2.running":
        return b(this.running2);
      case "pump.running":
        return b(this.pumpRunning);
      case "alarm.high_temp":
        return b(this.coldAisle > p.recommendedMax);
      case "alarm.critical_temp":
        return b(this.coldAisle > p.allowableMax);
      case "fire.alarm":
      case "fire.discharged":
        return b(this.released);
      case "temp.chw_supply":
        return Math.round(this.chws * 10);
      case "temp.cold_aisle":
      case "fire.temp":
        return Math.round(this.coldAisle * 10);
      case "load.it":
        return Math.round(this.load);
      case "power.cooling":
        return this.coolingPower;
      case "pue":
        return Math.round(this.pue * 100);
      default:
        return NaN;
    }
  }

  set(signal: string, value: number): boolean {
    const on = value === 1;
    switch (signal) {
      case "chiller1.enable":
        this.enable1 = on;
        return true;
      case "chiller2.enable":
        this.enable2 = on;
        return true;
      case "pump.run":
        this.pumpCommand = on;
        return true;
      case "control.auto":
        this.autoMode = on;
        return true;
      case "fire.isolate":
        this.fireIsolated = on;
        return true;
      case "fire.release":
        this.releaseCommand = on;
        return true;
      case "setpoint.chw":
        this.chwSp = value;
        return true;
      case "setpoint.supply_air":
        this.supplySp = value;
        return true;
      default:
        return false;
    }
  }

  alarms(): PlantAlarm[] {
    const p = this.params;
    const t = this.tags;
    const out: PlantAlarm[] = [];
    if (this.released) out.push({ id: "fire-released", text: `Suppression released in ${t.hall}: hall evacuated, IT load off`, severity: "critical" });
    if (this.itShutdown) out.push({ id: "shutdown", text: `Servers in ${t.hall} shutting down on over-temperature`, severity: "critical" });
    else if (this.coldAisle > p.allowableMax) out.push({ id: "temp-critical", text: `Cold aisle above ${p.allowableMax} °C: hardware at risk`, severity: "critical" });
    else if (this.coldAisle > p.recommendedMax) out.push({ id: "temp-high", text: `Cold aisle above ${p.recommendedMax} °C`, severity: "medium" });
    if (!this.pumpRunning) out.push({ id: "pump-stopped", text: `Chilled water pumps ${t.pump} stopped`, severity: "high" });
    else if (!this.running1 && !this.running2) out.push({ id: "no-cooling", text: "No chiller running", severity: "high" });
    if (this.enable1 !== this.enable2) out.push({ id: "redundancy", text: "Only one chiller available: no spare", severity: "low" });
    if (this.fireIsolated) out.push({ id: "fire-isolated", text: `Fire suppression in ${t.hall} isolated`, severity: "high" });
    if (!this.autoMode) out.push({ id: "manual", text: "Chiller plant in manual", severity: "low" });
    return out;
  }

  readouts(get: (signal: string) => number, ctx: { safety?: string }): Readout[] {
    const p = this.params;
    const t = this.tags;
    const aisle = get("temp.cold_aisle") / 10;
    const chws = get("temp.chw_supply") / 10;
    const r1 = get("chiller1.running") === 1;
    const r2 = get("chiller2.running") === 1;
    const e1 = get("chiller1.enable") === 1;
    const e2 = get("chiller2.enable") === 1;
    const pump = get("pump.running") === 1;
    const load = get("load.it");
    const isolated = get("fire.isolated") === 1;
    const released = get("fire.discharged") === 1;
    const chiller = (name: string, run: boolean, en: boolean) => `${name} ${run ? "running" : en ? "standby" : "OFF"}`;
    const chillers = `${chiller(t.chiller1, r1, e1)}, ${chiller(t.chiller2, r2, e2)}`;
    return [
      { id: "cold-aisle", label: `Cold aisle, ${t.hall}`, text: `${aisle.toFixed(1)} °C`, bar: (aisle / 40) * 100, note: `setpoint ${(get("setpoint.supply_air") / 10).toFixed(1)} °C, recommended max ${p.recommendedMax} °C`, state: aisle > p.allowableMax ? "bad" : aisle > p.recommendedMax ? "warn" : "ok", strip: `Cold aisle ${aisle.toFixed(1)} °C`, hmi: true },
      { id: "chw", label: "Chilled water supply", text: `${chws.toFixed(1)} °C`, note: `setpoint ${(get("setpoint.chw") / 10).toFixed(1)} °C`, state: chws > get("setpoint.chw") / 10 + 2 ? "warn" : "ok", hmi: true },
      { id: "chillers", label: "Chillers", text: chillers, note: get("control.auto") === 1 ? "auto, N+1" : "MANUAL", state: !r1 && !r2 ? "bad" : !(e1 && e2) ? "warn" : "ok", strip: `Chillers ${(r1 ? 1 : 0) + (r2 ? 1 : 0)} running`, hmi: true },
      { id: "pumps", label: `Chilled water pumps ${t.pump}`, text: pump ? "running" : "STOPPED", state: pump ? "ok" : "bad", hmi: true },
      { id: "it", label: "IT load", text: Number.isNaN(load) ? "no data" : `${load} kW`, note: `PUE ${(get("pue") / 100).toFixed(2)}, cooling ${get("power.cooling")} kW`, state: load < p.itLoad ? "bad" : "ok", strip: `IT ${load} kW` },
      { id: "fire", label: `Fire suppression${ctx.safety ? ` ${ctx.safety}` : ""}`, text: released ? "RELEASED" : isolated ? "ISOLATED" : "armed", state: released || isolated ? "bad" : "ok", strip: released ? "Agent released" : isolated ? "Fire isolated" : "Fire armed", hmi: true },
    ];
  }

  notes(): string[] {
    return this.overTempSeconds > 0 ? [`Servers above the allowable inlet temperature for ${Math.round(this.overTempSeconds)} s so far`] : [];
  }

  alarmDetail(id: string): string {
    const p = this.params;
    const t = this.tags;
    const chillers = `${t.chiller1} ${this.running1 ? "running" : this.enable1 ? "standby" : "disabled"}, ${t.chiller2} ${this.running2 ? "running" : this.enable2 ? "standby" : "disabled"}`;
    switch (id) {
      case "fire-released":
        return `The ${t.agent} was released in ${t.hall}. People must leave, the CRAH units stop and the IT load is shut down. Restoring takes hours and a refill.`;
      case "shutdown":
        return `Cold aisle ${this.coldAisle.toFixed(1)} °C passed ${p.shutdownTemp} °C and the servers protect themselves by shutting down. Services hosted in the hall are down.`;
      case "temp-critical":
        return `Cold aisle ${this.coldAisle.toFixed(1)} °C, above the allowable ${p.allowableMax} °C. ${chillers}, pumps ${this.pumpRunning ? "running" : "stopped"}, chilled water ${this.chws.toFixed(1)} °C (setpoint ${(this.chwSp / 10).toFixed(1)} °C).`;
      case "temp-high":
        return `Cold aisle ${this.coldAisle.toFixed(1)} °C, above the recommended ${p.recommendedMax} °C. Supply air setpoint ${(this.supplySp / 10).toFixed(1)} °C, chilled water ${this.chws.toFixed(1)} °C.`;
      case "pump-stopped":
        return `With the chilled water pumps stopped, the chillers trip on low flow and the CRAH coils get no cold water. The hall warms by about ${p.warmingRate} °C a minute.`;
      case "no-cooling":
        return `${chillers}. The chilled water is warming and the hall follows it.`;
      case "fire-isolated":
        return `The suppression release in ${t.hall} is isolated. If a fire starts, no agent is released. Isolation is for maintenance with a fire watch in place.`;
      default:
        return "";
    }
  }

  snapshot(): Record<string, number | boolean> {
    const r = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
    return {
      coldAisle: r(this.coldAisle, 1),
      chwSupply: r(this.chws, 1),
      chillersRunning: (this.running1 ? 1 : 0) + (this.running2 ? 1 : 0),
      chiller1Enabled: this.enable1,
      chiller2Enabled: this.enable2,
      pumpRunning: this.pumpRunning,
      autoMode: this.autoMode,
      itLoad: Math.round(this.load),
      itShutdown: this.itShutdown,
      overTempSeconds: r(this.overTempSeconds, 1),
      fireIsolated: this.fireIsolated,
      fireReleased: this.released,
      chwSetpoint: this.chwSp,
      supplyAirSetpoint: this.supplySp,
      pue: r(this.pue, 2),
    };
  }
}

export const DC_COOLING: ProcessModelType = {
  model: "dc-cooling",
  description: "Cooling and power for a data hall: N+1 chillers, chilled water pumps, CRAH units, a power meter and a fire suppression panel.",
  signals: SIGNALS,
  params: PARAMS,
  tags: TAGS,
  check(p) {
    const e: string[] = [];
    if (!(p.recommendedMax < p.allowableMax && p.allowableMax < p.shutdownTemp)) e.push("temperatures must be in order: recommendedMax < allowableMax < shutdownTemp");
    if (p.supplyAirSetpoint >= p.recommendedMax) e.push("supplyAirSetpoint must be below recommendedMax");
    if (p.chwSetpoint + p.approach > p.recommendedMax) e.push("chwSetpoint + approach must not exceed recommendedMax, or the hall runs warm from the start");
    if (p.chillerCapacity < p.itLoad) e.push("one chiller must carry the IT load (chillerCapacity >= itLoad), so the other is a spare");
    return e;
  },
  create: (params, tags) => new DcCooling(params, tags),
};
