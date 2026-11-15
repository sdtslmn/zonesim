// The physical process: a small water treatment plant.
//
//   river ──► P-101 inlet pump ──► T-101 tank ──► town (constant demand)
//                                     ▲
//                         P-201 chlorine dosing
//
// plc-1 keeps the tank level between two setpoints and doses chlorine.
// sis-1 is an independent safety system: it stops the inlet pump when the
// level reaches high-high, unless someone bypasses it. Both talk Modbus TCP
// with no authentication, like most real controllers in the field.
//
// Everything here is fictional: the vendor, the products and the register maps.

export type PointTable = "coil" | "di" | "ir" | "hr";
export type DeviceName = "plc-1" | "sis-1";

export interface ModbusRequest {
  fc: number;
  addr: number;
  count?: number;
  values?: number[];
}

export interface ModbusReply {
  ok: boolean;
  values?: number[];
  exception?: number;
  deviceId?: { vendor: string; product: string; revision: string };
}

export const FC_NAMES: Record<number, string> = {
  1: "read coils",
  2: "read discrete inputs",
  3: "read holding registers",
  4: "read input registers",
  5: "write single coil",
  6: "write single register",
  15: "write multiple coils",
  16: "write multiple registers",
  43: "read device identification",
};

export const READ_FCS = [1, 2, 3, 4, 43];
export const WRITE_FCS = [5, 6, 15, 16];

export const EXCEPTIONS: Record<number, string> = {
  1: "illegal function",
  2: "illegal data address",
  3: "illegal data value",
};

export interface PointDef {
  addr: number;
  tag: string;
  description: string;
  /** How to read the raw value, e.g. "tenths of a %". */
  units?: string;
}

export interface DeviceMap {
  title: string;
  vendor: string;
  product: string;
  revision: string;
  coil: PointDef[];
  di: PointDef[];
  ir: PointDef[];
  hr: PointDef[];
}

export const DEVICE_MAPS: Record<DeviceName, DeviceMap> = {
  "plc-1": {
    title: "plc-1: tank and dosing controller",
    vendor: "ZoneSim Controls",
    product: "ZS-PLC 100",
    revision: "2.4.1",
    coil: [
      { addr: 0, tag: "P101_RUN_CMD", description: "Inlet pump P-101 run command (used in manual mode only)" },
      { addr: 1, tag: "P201_ENABLE", description: "Chlorine dosing pump P-201 enable" },
      { addr: 2, tag: "AUTO_MODE", description: "1 = automatic level control, 0 = manual" },
    ],
    di: [
      { addr: 0, tag: "P101_RUNNING", description: "Inlet pump P-101 is running" },
      { addr: 1, tag: "P201_RUNNING", description: "Dosing pump P-201 is running" },
      { addr: 2, tag: "LAH_101", description: "Tank level high alarm (85 %)" },
      { addr: 3, tag: "LAL_101", description: "Tank level low alarm (20 %)" },
      { addr: 4, tag: "OVERFLOW", description: "Tank T-101 is overflowing" },
    ],
    ir: [
      { addr: 0, tag: "LT_101", description: "Tank T-101 level", units: "tenths of a %, 623 = 62.3 %" },
      { addr: 1, tag: "AIT_201", description: "Chlorine residual", units: "hundredths of mg/L, 150 = 1.50 mg/L" },
    ],
    hr: [
      { addr: 0, tag: "LSP_START", description: "Pump start level in auto mode", units: "tenths of a %, default 400" },
      { addr: 1, tag: "LSP_STOP", description: "Pump stop level in auto mode", units: "tenths of a %, default 800" },
      { addr: 2, tag: "CL_SETPOINT", description: "Chlorine dosing setpoint", units: "hundredths of mg/L, default 150" },
    ],
  },
  "sis-1": {
    title: "sis-1: safety instrumented system",
    vendor: "ZoneSim Controls",
    product: "ZS-SIS 20",
    revision: "1.8.0",
    coil: [{ addr: 0, tag: "HH_BYPASS", description: "Maintenance bypass of the high-high level trip (1 = bypassed)" }],
    di: [
      { addr: 0, tag: "TRIP_ACTIVE", description: "High-high trip active, inlet pump P-101 held off" },
      { addr: 1, tag: "BYPASS_ACTIVE", description: "High-high trip is bypassed" },
    ],
    ir: [{ addr: 0, tag: "LT_102", description: "Independent tank level transmitter", units: "tenths of a %" }],
    hr: [{ addr: 0, tag: "LSHH_SP", description: "High-high trip level", units: "tenths of a %, default 950" }],
  },
};

export interface PlantAlarm {
  id: string;
  text: string;
  severity: "critical" | "high" | "medium" | "low";
}

/** Rates in percent of tank volume per second. */
const INFLOW = 1.2;
const DEMAND = 0.5;

export class Plant {
  /** Tank level in percent. */
  level = 55;
  /** Chlorine residual in mg/L. */
  chlorine = 1.5;
  pumpRunning = false;
  sisTrip = false;
  /** Seconds the tank has spent overflowing. */
  overflowSeconds = 0;
  pumpStarts = 0;
  /** plc-1 coils: run command, dosing enable, auto mode. */
  readonly plcCoils = [false, true, true];
  /** plc-1 holding registers: start level, stop level, chlorine setpoint. */
  readonly plcHr = [400, 800, 150];
  /** sis-1 coils: high-high bypass. */
  readonly sisCoils = [false];
  /** sis-1 holding registers: high-high trip level. */
  readonly sisHr = [950];
  private autoCall = false;

  get dosingRunning(): boolean {
    return this.plcCoils[1];
  }

  get autoMode(): boolean {
    return this.plcCoils[2];
  }

  get bypassed(): boolean {
    return this.sisCoils[0];
  }

  get overflowing(): boolean {
    return this.level >= 100 && this.pumpRunning;
  }

  /** Move the process forward by dt seconds. */
  step(dt: number): void {
    // plc-1 logic: hysteresis between the start and stop levels, or the manual command.
    const tenths = this.level * 10;
    if (this.autoMode) {
      if (tenths <= this.plcHr[0]) this.autoCall = true;
      if (tenths >= this.plcHr[1]) this.autoCall = false;
    }
    const command = this.autoMode ? this.autoCall : this.plcCoils[0];

    // sis-1 logic: trip on high-high, reset once the level is back below 80 %.
    if (this.bypassed) this.sisTrip = false;
    else if (tenths >= this.sisHr[0]) this.sisTrip = true;
    else if (this.sisTrip && this.level <= 80) this.sisTrip = false;

    const running = command && !this.sisTrip;
    if (running && !this.pumpRunning) this.pumpStarts++;
    this.pumpRunning = running;

    const inflow = running ? INFLOW : 0;
    const outflow = this.level > 0 ? DEMAND : 0;
    this.level = Math.min(100, Math.max(0, this.level + (inflow - outflow) * dt));
    if (this.overflowing) this.overflowSeconds += dt;

    const target = this.dosingRunning ? this.plcHr[2] / 100 : 0;
    const tau = this.dosingRunning ? 15 : 40;
    this.chlorine += (target - this.chlorine) * Math.min(1, dt / tau);
  }

  private table(device: DeviceName, t: PointTable): number[] {
    const b = (v: boolean) => (v ? 1 : 0);
    if (device === "plc-1") {
      switch (t) {
        case "coil":
          return this.plcCoils.map(b);
        case "di":
          return [b(this.pumpRunning), b(this.dosingRunning), b(this.level >= 85), b(this.level <= 20), b(this.overflowing)];
        case "ir":
          return [Math.round(this.level * 10), Math.round(this.chlorine * 100)];
        case "hr":
          return [...this.plcHr];
      }
    }
    switch (t) {
      case "coil":
        return this.sisCoils.map(b);
      case "di":
        return [b(this.sisTrip), b(this.bypassed)];
      case "ir":
        return [Math.round(this.level * 10)];
      case "hr":
        return [...this.sisHr];
    }
  }

  /** Read a point directly, without going over the network (used by lab checks and the HMI view). */
  point(device: DeviceName, t: PointTable, addr: number): number | undefined {
    return this.table(device, t)[addr];
  }

  /** Answer a Modbus request the way the controller would. */
  modbus(device: DeviceName, req: ModbusRequest): ModbusReply {
    const count = req.count ?? 1;
    const read = (t: PointTable): ModbusReply => {
      const all = this.table(device, t);
      if (count < 1 || count > 125 || req.addr < 0 || req.addr + count > all.length) return { ok: false, exception: 2 };
      return { ok: true, values: all.slice(req.addr, req.addr + count) };
    };
    const coils = device === "plc-1" ? this.plcCoils : this.sisCoils;
    const regs = device === "plc-1" ? this.plcHr : this.sisHr;
    const write = (target: (boolean | number)[], values: number[] | undefined, isCoil: boolean): ModbusReply => {
      if (!values || values.length === 0) return { ok: false, exception: 3 };
      if (req.addr < 0 || req.addr + values.length > target.length) return { ok: false, exception: 2 };
      for (const v of values) {
        if (!Number.isInteger(v) || (isCoil ? v !== 0 && v !== 1 : v < 0 || v > 65535)) return { ok: false, exception: 3 };
      }
      values.forEach((v, i) => (target[req.addr + i] = isCoil ? v === 1 : v));
      return { ok: true, values };
    };
    switch (req.fc) {
      case 1:
        return read("coil");
      case 2:
        return read("di");
      case 3:
        return read("hr");
      case 4:
        return read("ir");
      case 5:
        return write(coils, req.values?.slice(0, 1), true);
      case 6:
        return write(regs, req.values?.slice(0, 1), false);
      case 15:
        return write(coils, req.values, true);
      case 16:
        return write(regs, req.values, false);
      case 43: {
        const m = DEVICE_MAPS[device];
        return { ok: true, deviceId: { vendor: m.vendor, product: m.product, revision: m.revision } };
      }
      default:
        return { ok: false, exception: 1 };
    }
  }

  alarms(): PlantAlarm[] {
    const out: PlantAlarm[] = [];
    if (this.overflowing) out.push({ id: "overflow", text: "Tank T-101 is overflowing", severity: "critical" });
    else if (this.level >= 95) out.push({ id: "level-hh", text: "Tank T-101 level high-high", severity: "critical" });
    else if (this.level >= 85) out.push({ id: "level-h", text: "Tank T-101 level high", severity: "medium" });
    if (this.level <= 20) out.push({ id: "level-l", text: "Tank T-101 level low", severity: "medium" });
    if (this.sisTrip) out.push({ id: "sis-trip", text: "SIS tripped: inlet pump P-101 held off", severity: "high" });
    if (this.bypassed) out.push({ id: "sis-bypass", text: "SIS high-high trip is bypassed", severity: "high" });
    if (this.chlorine < 0.5) out.push({ id: "cl-low", text: "Chlorine residual low: water may be unsafe", severity: "high" });
    if (this.chlorine > 4) out.push({ id: "cl-high", text: "Chlorine residual high: overdosing", severity: "high" });
    if (!this.autoMode) out.push({ id: "manual", text: "plc-1 is in manual mode", severity: "low" });
    return out;
  }
}
