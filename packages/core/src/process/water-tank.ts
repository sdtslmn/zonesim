// The "water-tank" process model:
//
//   source ──► inlet pump ──► tank ──► consumer (constant demand)
//                               ▲
//                        chlorine dosing
//
// Level control keeps the tank between a start and a stop level (or follows
// a manual pump command). An independent safety function stops the pump at
// a trip level unless it is bypassed. All numbers come from the site file.

import type { PlantAlarm, ProcessModel, ProcessModelType, ParamSpec, SignalSpec } from "./model.js";

const PARAMS: ParamSpec[] = [
  { name: "initialLevel", default: 55, min: 0, max: 100, description: "Tank level at start, %" },
  { name: "inflow", default: 1.2, min: 0.01, max: 20, description: "Level rise per second while the inlet pump runs, %" },
  { name: "demand", default: 0.5, min: 0, max: 20, description: "Level drop per second from consumption, %" },
  { name: "startLevel", default: 40, min: 0, max: 100, description: "Default pump start level in auto mode, %" },
  { name: "stopLevel", default: 80, min: 0, max: 100, description: "Default pump stop level in auto mode, %" },
  { name: "lowAlarm", default: 20, min: 0, max: 100, description: "Low level alarm, %" },
  { name: "highAlarm", default: 85, min: 0, max: 100, description: "High level alarm, %" },
  { name: "highHighAlarm", default: 95, min: 0, max: 100, description: "High-high level alarm, %" },
  { name: "tripLevel", default: 95, min: 0, max: 100, description: "Default safety trip level, %" },
  { name: "tripReset", default: 80, min: 0, max: 100, description: "The safety trip resets below this level, %" },
  { name: "chlorineSetpoint", default: 1.5, min: 0, max: 20, description: "Default chlorine setpoint, mg/L" },
  { name: "chlorineInitial", default: 1.5, min: 0, max: 20, description: "Chlorine residual at start, mg/L" },
  { name: "chlorineLow", default: 0.5, min: 0, max: 20, description: "Low chlorine alarm, mg/L" },
  { name: "chlorineHigh", default: 4, min: 0, max: 20, description: "High chlorine alarm, mg/L" },
  { name: "chlorineTau", default: 15, min: 1, max: 3600, description: "Seconds for the residual to follow the setpoint" },
  { name: "chlorineDecay", default: 40, min: 1, max: 3600, description: "Seconds for the residual to decay with dosing off" },
];

const SIGNALS: SignalSpec[] = [
  { name: "pump.command", type: "bool", writable: true, description: "Inlet pump run command in manual mode" },
  { name: "dosing.enable", type: "bool", writable: true, description: "Chlorine dosing on or off" },
  { name: "control.auto", type: "bool", writable: true, description: "1 = automatic level control, 0 = manual" },
  { name: "sis.bypass", type: "bool", writable: true, description: "Bypass of the safety trip" },
  { name: "setpoint.start", type: "int", writable: true, description: "Pump start level, tenths of a %" },
  { name: "setpoint.stop", type: "int", writable: true, description: "Pump stop level, tenths of a %" },
  { name: "setpoint.chlorine", type: "int", writable: true, description: "Chlorine setpoint, hundredths of mg/L" },
  { name: "sis.trip_level", type: "int", writable: true, description: "Safety trip level, tenths of a %" },
  { name: "pump.running", type: "bool", writable: false, description: "Inlet pump is running" },
  { name: "dosing.running", type: "bool", writable: false, description: "Dosing pump is running" },
  { name: "alarm.high", type: "bool", writable: false, description: "High level alarm" },
  { name: "alarm.low", type: "bool", writable: false, description: "Low level alarm" },
  { name: "alarm.overflow", type: "bool", writable: false, description: "Tank is overflowing" },
  { name: "sis.tripped", type: "bool", writable: false, description: "Safety trip active" },
  { name: "sis.bypassed", type: "bool", writable: false, description: "Safety trip is bypassed" },
  { name: "level", type: "int", writable: false, description: "Tank level, tenths of a %" },
  { name: "chlorine", type: "int", writable: false, description: "Chlorine residual, hundredths of mg/L" },
  { name: "sis.level", type: "int", writable: false, description: "Independent level measurement, tenths of a %" },
];

const TAGS = { source: "river", consumer: "town", tank: "T-101", pump: "P-101", dosing: "P-201" };

export class WaterTank implements ProcessModel {
  readonly model = "water-tank";
  level: number;
  chlorine: number;
  pumpRunning = false;
  sisTrip = false;
  overflowSeconds = 0;
  pumpStarts = 0;
  /** Writable state. Setpoints are stored raw, as the controller holds them. */
  pumpCommand = false;
  dosingEnable = true;
  autoMode = true;
  bypass = false;
  startSp: number;
  stopSp: number;
  chlorineSp: number;
  tripSp: number;
  private autoCall = false;

  constructor(
    readonly params: Record<string, number>,
    readonly tags: Record<string, string>,
  ) {
    this.level = params.initialLevel;
    this.chlorine = params.chlorineInitial;
    this.startSp = Math.round(params.startLevel * 10);
    this.stopSp = Math.round(params.stopLevel * 10);
    this.chlorineSp = Math.round(params.chlorineSetpoint * 100);
    this.tripSp = Math.round(params.tripLevel * 10);
  }

  get dosingRunning(): boolean {
    return this.dosingEnable;
  }

  get bypassed(): boolean {
    return this.bypass;
  }

  get overflowing(): boolean {
    return this.level >= 100 && this.pumpRunning;
  }

  step(dt: number): void {
    const p = this.params;
    const tenths = this.level * 10;
    if (this.autoMode) {
      if (tenths <= this.startSp) this.autoCall = true;
      if (tenths >= this.stopSp) this.autoCall = false;
    }
    const command = this.autoMode ? this.autoCall : this.pumpCommand;

    if (this.bypass) this.sisTrip = false;
    else if (tenths >= this.tripSp) this.sisTrip = true;
    else if (this.sisTrip && this.level <= p.tripReset) this.sisTrip = false;

    const running = command && !this.sisTrip;
    if (running && !this.pumpRunning) this.pumpStarts++;
    this.pumpRunning = running;

    const inflow = running ? p.inflow : 0;
    const outflow = this.level > 0 ? p.demand : 0;
    this.level = Math.min(100, Math.max(0, this.level + (inflow - outflow) * dt));
    if (this.overflowing) this.overflowSeconds += dt;

    const target = this.dosingEnable ? this.chlorineSp / 100 : 0;
    const tau = this.dosingEnable ? p.chlorineTau : p.chlorineDecay;
    this.chlorine += (target - this.chlorine) * Math.min(1, dt / tau);
  }

  get(signal: string): number {
    const b = (v: boolean) => (v ? 1 : 0);
    const p = this.params;
    switch (signal) {
      case "pump.command":
        return b(this.pumpCommand);
      case "dosing.enable":
        return b(this.dosingEnable);
      case "control.auto":
        return b(this.autoMode);
      case "sis.bypass":
        return b(this.bypass);
      case "setpoint.start":
        return this.startSp;
      case "setpoint.stop":
        return this.stopSp;
      case "setpoint.chlorine":
        return this.chlorineSp;
      case "sis.trip_level":
        return this.tripSp;
      case "pump.running":
        return b(this.pumpRunning);
      case "dosing.running":
        return b(this.dosingRunning);
      case "alarm.high":
        return b(this.level >= p.highAlarm);
      case "alarm.low":
        return b(this.level <= p.lowAlarm);
      case "alarm.overflow":
        return b(this.overflowing);
      case "sis.tripped":
        return b(this.sisTrip);
      case "sis.bypassed":
        return b(this.bypass);
      case "level":
      case "sis.level":
        return Math.round(this.level * 10);
      case "chlorine":
        return Math.round(this.chlorine * 100);
      default:
        return NaN;
    }
  }

  set(signal: string, value: number): boolean {
    const on = value === 1;
    switch (signal) {
      case "pump.command":
        this.pumpCommand = on;
        return true;
      case "dosing.enable":
        this.dosingEnable = on;
        return true;
      case "control.auto":
        this.autoMode = on;
        return true;
      case "sis.bypass":
        this.bypass = on;
        return true;
      case "setpoint.start":
        this.startSp = value;
        return true;
      case "setpoint.stop":
        this.stopSp = value;
        return true;
      case "setpoint.chlorine":
        this.chlorineSp = value;
        return true;
      case "sis.trip_level":
        this.tripSp = value;
        return true;
      default:
        return false;
    }
  }

  alarms(): PlantAlarm[] {
    const p = this.params;
    const t = this.tags;
    const out: PlantAlarm[] = [];
    if (this.overflowing) out.push({ id: "overflow", text: `Tank ${t.tank} is overflowing`, severity: "critical" });
    else if (this.level >= p.highHighAlarm) out.push({ id: "level-hh", text: `Tank ${t.tank} level high-high`, severity: "critical" });
    else if (this.level >= p.highAlarm) out.push({ id: "level-h", text: `Tank ${t.tank} level high`, severity: "medium" });
    if (this.level <= p.lowAlarm) out.push({ id: "level-l", text: `Tank ${t.tank} level low`, severity: "medium" });
    if (this.sisTrip) out.push({ id: "sis-trip", text: `Safety trip: inlet pump ${t.pump} held off`, severity: "high" });
    if (this.bypass) out.push({ id: "sis-bypass", text: "Safety trip is bypassed", severity: "high" });
    if (this.chlorine < p.chlorineLow) out.push({ id: "cl-low", text: "Chlorine residual low: water may be unsafe", severity: "high" });
    if (this.chlorine > p.chlorineHigh) out.push({ id: "cl-high", text: "Chlorine residual high: overdosing", severity: "high" });
    if (!this.autoMode) out.push({ id: "manual", text: "Level control is in manual mode", severity: "low" });
    return out;
  }
}

export const WATER_TANK: ProcessModelType = {
  model: "water-tank",
  description: "A tank filled by a pump with level control, chlorine dosing and a safety trip on high level.",
  signals: SIGNALS,
  params: PARAMS,
  tags: TAGS,
  check(p) {
    const errors: string[] = [];
    if (p.stopLevel <= p.startLevel) errors.push("stopLevel must be above startLevel");
    if (p.inflow <= p.demand) errors.push("inflow must be larger than demand, or the pump can never fill the tank");
    if (!(p.lowAlarm < p.highAlarm && p.highAlarm <= p.highHighAlarm)) errors.push("alarms must be in order: lowAlarm < highAlarm <= highHighAlarm");
    if (p.tripReset >= p.tripLevel) errors.push("tripReset must be below tripLevel");
    if (p.chlorineLow >= p.chlorineHigh) errors.push("chlorineLow must be below chlorineHigh");
    return errors;
  },
  create: (params, tags) => new WaterTank(params, tags),
};
