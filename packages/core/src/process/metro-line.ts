// The "metro-line" process model: traction power and tunnel ventilation for
// one section of a metro line.
//
//   rectifier RECT-1 ──► feeder breaker CB-11 ──► 750 V DC third rail ──► trains
//   tunnel fans TVF-1, TVF-2 ──► tunnel air
//
// The traction power controller (PCS) closes the feeder breaker to energize
// the line, protects it with an overcurrent trip and can reclose once after a
// trip. With the line dead, trains stop where they are and the ones in the
// tunnel are stranded. The tunnel ventilation controller (TVS) starts the fans
// on tunnel temperature and has a fire mode that runs both fans at full and
// holds the trains at stations. Stranded trains with no ventilation heat the
// tunnel quickly.
//
// The emergency trip system (ETS) is the safety system: it keeps the
// rectifier off while a work crew is on the track (a possession), and backs
// up the feeder protection on a short circuit. A possession is registered on
// the PCS by the station control room; the PCS then opens the feeder and no
// trains run.

import type { PlantAlarm, ProcessModel, ProcessModelType, ParamSpec, SignalSpec, Readout, TrendSpec } from "./model.js";

const PARAMS: ParamSpec[] = [
  { name: "trains", default: 6, min: 1, max: 60, description: "Trains in service on the section" },
  { name: "lineVoltage", default: 750, min: 100, max: 3000, description: "Line voltage with no load, V DC" },
  { name: "trainCurrent", default: 400, min: 10, max: 5000, description: "Average current each moving train draws, A" },
  { name: "overcurrent", default: 5000, min: 100, max: 60000, description: "Default feeder overcurrent trip setting, A" },
  { name: "etsTrip", default: 9000, min: 100, max: 60000, description: "Default emergency trip system backup trip, A" },
  { name: "faultCurrent", default: 12000, min: 100, max: 100000, description: "Current of a short circuit on the line, A" },
  { name: "tunnelShare", default: 67, min: 0, max: 100, description: "Share of the trains that are in the tunnel at any time, %" },
  { name: "ambient", default: 26, min: -20, max: 45, description: "Tunnel temperature with no trains, °C" },
  { name: "fanStart", default: 30, min: 10, max: 50, description: "Default tunnel temperature at which the first fan starts, °C" },
  { name: "hotAlarm", default: 35, min: 10, max: 60, description: "Tunnel temperature high alarm, °C" },
  { name: "heatStress", default: 40, min: 10, max: 70, description: "Tunnel temperature at which passengers in a stranded train are at risk, °C" },
  { name: "possessionTime", default: 1800, min: 60, max: 36000, description: "How long a work crew stays on the track once a possession starts, s" },
];

const SIGNALS: SignalSpec[] = [
  { name: "feeder.command", type: "bool", writable: true, description: "Feeder breaker close command: 1 = energize the line section" },
  { name: "rectifier.enable", type: "bool", writable: true, description: "Rectifier on" },
  { name: "control.auto", type: "bool", writable: true, description: "1 = reclose the feeder once after a protection trip" },
  { name: "possession", type: "bool", writable: true, description: "Work possession registered: a crew is on the track, the PCS holds the feeder open" },
  { name: "setpoint.overcurrent", type: "int", writable: true, description: "Feeder overcurrent trip setting, A" },
  { name: "fan1.run", type: "bool", writable: true, description: "Tunnel fan 1 run command in manual" },
  { name: "fan2.run", type: "bool", writable: true, description: "Tunnel fan 2 run command in manual" },
  { name: "vent.auto", type: "bool", writable: true, description: "1 = the TVS starts the fans on tunnel temperature, 0 = manual" },
  { name: "fire.mode", type: "bool", writable: true, description: "Fire mode: both fans at full, trains held at stations" },
  { name: "setpoint.fan_start", type: "int", writable: true, description: "Tunnel temperature at which the first fan starts, tenths of a °C" },
  { name: "sis.bypass", type: "bool", writable: true, description: "Bypass of the emergency trip system" },
  { name: "sis.trip_current", type: "int", writable: true, description: "Emergency trip system backup trip, A" },
  { name: "feeder.closed", type: "bool", writable: false, description: "Feeder breaker closed" },
  { name: "rectifier.running", type: "bool", writable: false, description: "Rectifier running" },
  { name: "alarm.trip", type: "bool", writable: false, description: "Feeder breaker tripped on overcurrent" },
  { name: "voltage.line", type: "int", writable: false, description: "Line voltage, V" },
  { name: "current.feeder", type: "int", writable: false, description: "Feeder current, A" },
  { name: "trains.moving", type: "int", writable: false, description: "Trains moving" },
  { name: "trains.stranded", type: "int", writable: false, description: "Trains stopped in the tunnel" },
  { name: "fan1.running", type: "bool", writable: false, description: "Tunnel fan 1 running" },
  { name: "fan2.running", type: "bool", writable: false, description: "Tunnel fan 2 running" },
  { name: "alarm.tunnel_hot", type: "bool", writable: false, description: "Tunnel temperature high" },
  { name: "fire.mode_active", type: "bool", writable: false, description: "Fire mode active" },
  { name: "temp.tunnel", type: "int", writable: false, description: "Tunnel temperature, tenths of a °C" },
  { name: "sis.tripped", type: "bool", writable: false, description: "Emergency trip active: rectifier held off" },
  { name: "sis.bypassed", type: "bool", writable: false, description: "Emergency trip system bypassed" },
  { name: "crew.on_track", type: "bool", writable: false, description: "Possession key switch: a work crew is on the track" },
  { name: "sis.current", type: "int", writable: false, description: "Independent feeder current measurement, A" },
];

const TAGS = { line: "Meridian Line", substation: "TPSS-1", rectifier: "RECT-1", feeder: "CB-11", fan1: "TVF-1", fan2: "TVF-2", tunnel: "Central to Quay tunnel" };

export class MetroLine implements ProcessModel {
  readonly model = "metro-line";
  readonly quietAlarms = ["vent-manual", "possession"];
  readonly headline = "trains";
  readonly trends: TrendSpec[] = [
    { signal: "temp.tunnel", label: "Tunnel temperature", scale: 0.1, max: 50 },
    { signal: "current.feeder", label: "Feeder current", scale: 1, max: 6000 },
  ];

  time = 0;
  tunnelTemp: number;
  current = 0;
  feederClosed = true;
  tripped = false;
  trips = 0;
  recloses = 0;
  recloseAt?: number;
  lastTrip = -1e9;
  overFor = 0;
  rectRunning = true;
  moving: number;
  stranded = 0;
  restartFor = 0;
  fan1 = false;
  fan2 = false;
  crewUntil = -1;
  etsCurrentTrip = false;
  etsTripAt = 0;
  strandedSeconds = 0;
  liveWithCrewSeconds = 0;
  heatStressSeconds = 0;

  feederCmd = true;
  rectEnable = true;
  autoReclose = true;
  possession = false;
  overcurrentSp: number;
  fan1Cmd = false;
  fan2Cmd = false;
  ventAuto = true;
  fireMode = false;
  fanStartSp: number;
  bypass = false;
  etsTripSp: number;

  constructor(
    readonly params: Record<string, number>,
    readonly tags: Record<string, string>,
  ) {
    this.overcurrentSp = Math.round(params.overcurrent);
    this.etsTripSp = Math.round(params.etsTrip);
    this.fanStartSp = Math.round(params.fanStart * 10);
    this.moving = params.trains;
    this.tunnelTemp = this.equilibrium();
  }

  get crewOnTrack(): boolean {
    return this.possession || this.time < this.crewUntil;
  }

  get etsTripped(): boolean {
    return !this.bypass && (this.crewOnTrack || this.etsCurrentTrip);
  }

  get energized(): boolean {
    return this.feederClosed && this.rectRunning;
  }

  get voltage(): number {
    return this.energized ? Math.max(0, this.params.lineVoltage - 0.02 * this.current) : 0;
  }

  get fansRunning(): number {
    return (this.fan1 ? 1 : 0) + (this.fan2 ? 1 : 0);
  }

  /** Trains in service: none while a possession is in force. */
  get inService(): number {
    return this.crewOnTrack ? 0 : this.params.trains;
  }

  /** True when a short circuit on the line would not be cleared by either layer of protection. */
  get unprotected(): boolean {
    const f = this.params.faultCurrent;
    return this.overcurrentSp >= f && (this.bypass || this.etsTripSp >= f);
  }

  private equilibrium(): number {
    const p = this.params;
    const share = p.tunnelShare / 100;
    const inTunnel = this.moving * share * 1.2 + this.stranded * 1.5;
    const vent = 0.3 + (p.trains ? (1.5 * this.moving) / p.trains : 0) + 1.5 * this.fansRunning;
    return p.ambient + inTunnel / vent;
  }

  step(dt: number): void {
    const p = this.params;
    this.time += dt;

    // A possession keeps the feeder open; the crew stays on the track for a while once there.
    if (this.possession) this.feederClosed = false;

    // Emergency trip system: crew on the track, or a backup trip on very high current.
    if (!this.bypass && this.current > this.etsTripSp) {
      this.etsCurrentTrip = true;
      this.etsTripAt = this.time;
    }
    if (this.etsCurrentTrip && this.time - this.etsTripAt > 30) this.etsCurrentTrip = false;
    this.rectRunning = this.rectEnable && !this.etsTripped;

    // Feeder protection and auto reclose.
    if (!this.feederCmd) this.feederClosed = false;
    if (this.feederClosed && this.current > this.overcurrentSp) {
      this.overFor += dt;
      if (this.overFor >= 0.5) {
        this.feederClosed = false;
        this.tripped = true;
        this.trips++;
        this.lastTrip = this.time;
        this.recloseAt = this.autoReclose && this.recloses < 1 ? this.time + 10 : undefined;
      }
    } else this.overFor = 0;
    if (this.tripped && this.recloseAt !== undefined && this.time >= this.recloseAt) {
      this.recloseAt = undefined;
      if (this.feederCmd && !this.possession) {
        this.feederClosed = true;
        this.tripped = false;
        this.recloses++;
      }
    }
    if (this.recloses && this.feederClosed && this.time - this.lastTrip > 120) this.recloses = 0;

    // Trains: they run on a live line, stop where they are on a dead one, and hold at stations in fire mode.
    const service = this.inService;
    if (this.energized && !this.fireMode) {
      if (this.moving < service) this.restartFor = 20;
      this.moving = service;
      this.stranded = 0;
    } else if (this.energized) {
      // Fire mode: the trains run on to the next station and hold there.
      this.moving = 0;
      this.stranded = 0;
    } else {
      if (this.moving > 0) this.stranded = Math.round(this.moving * (p.tunnelShare / 100));
      this.moving = 0;
      if (!service) this.stranded = 0;
    }
    this.restartFor = Math.max(0, this.restartFor - dt);

    // Feeder current, with the rhythm of trains accelerating and coasting.
    if (this.energized) {
      const base = this.moving * p.trainCurrent;
      this.current = Math.max(0, base * (1 + 0.25 * Math.sin((2 * Math.PI * this.time) / 45)) * (this.restartFor > 0 ? 1.5 : 1));
    } else this.current = 0;

    // Tunnel fans: on temperature in auto, both at full in fire mode, as commanded in manual.
    const sp = this.fanStartSp / 10;
    if (this.fireMode) {
      this.fan1 = true;
      this.fan2 = true;
    } else if (this.ventAuto) {
      if (this.tunnelTemp > sp) this.fan1 = true;
      else if (this.tunnelTemp < sp - 2) this.fan1 = false;
      if (this.tunnelTemp > sp + 2) this.fan2 = true;
      else if (this.tunnelTemp < sp) this.fan2 = false;
    } else {
      this.fan1 = this.fan1Cmd;
      this.fan2 = this.fan2Cmd;
    }

    // Tunnel air follows the heat of the trains and the airflow (piston effect and fans).
    this.tunnelTemp += (this.equilibrium() - this.tunnelTemp) * Math.min(1, dt / 240);

    if (this.stranded > 0) this.strandedSeconds += dt;
    if (this.energized && this.crewOnTrack) this.liveWithCrewSeconds += dt;
    if (this.stranded > 0 && this.tunnelTemp > p.heatStress) this.heatStressSeconds += dt;
  }

  get(signal: string): number {
    const b = (v: boolean) => (v ? 1 : 0);
    switch (signal) {
      case "feeder.command":
        return b(this.feederCmd);
      case "rectifier.enable":
        return b(this.rectEnable);
      case "control.auto":
        return b(this.autoReclose);
      case "possession":
        return b(this.possession);
      case "setpoint.overcurrent":
        return this.overcurrentSp;
      case "fan1.run":
        return b(this.fan1Cmd);
      case "fan2.run":
        return b(this.fan2Cmd);
      case "vent.auto":
        return b(this.ventAuto);
      case "fire.mode":
      case "fire.mode_active":
        return b(this.fireMode);
      case "setpoint.fan_start":
        return this.fanStartSp;
      case "sis.bypass":
      case "sis.bypassed":
        return b(this.bypass);
      case "sis.trip_current":
        return this.etsTripSp;
      case "feeder.closed":
        return b(this.feederClosed);
      case "rectifier.running":
        return b(this.rectRunning);
      case "alarm.trip":
        return b(this.tripped && !this.feederClosed);
      case "voltage.line":
        return Math.round(this.voltage);
      case "current.feeder":
      case "sis.current":
        return Math.round(this.current);
      case "trains.moving":
        return this.moving;
      case "trains.stranded":
        return this.stranded;
      case "fan1.running":
        return b(this.fan1);
      case "fan2.running":
        return b(this.fan2);
      case "alarm.tunnel_hot":
        return b(this.tunnelTemp > this.params.hotAlarm);
      case "temp.tunnel":
        return Math.round(this.tunnelTemp * 10);
      case "sis.tripped":
        return b(this.etsTripped);
      case "crew.on_track":
        return b(this.crewOnTrack);
      default:
        return NaN;
    }
  }

  set(signal: string, value: number): boolean {
    const on = value === 1;
    switch (signal) {
      case "feeder.command":
        // A close command also resets a protection trip. The PCS refuses it during a possession.
        if (on && !this.possession) {
          this.feederClosed = true;
          this.tripped = false;
          this.recloseAt = undefined;
          this.recloses = 0;
        }
        this.feederCmd = on;
        return true;
      case "rectifier.enable":
        this.rectEnable = on;
        return true;
      case "control.auto":
        this.autoReclose = on;
        return true;
      case "possession":
        this.possession = on;
        if (on) this.crewUntil = Math.max(this.crewUntil, this.time + this.params.possessionTime);
        return true;
      case "setpoint.overcurrent":
        this.overcurrentSp = value;
        return true;
      case "fan1.run":
        this.fan1Cmd = on;
        return true;
      case "fan2.run":
        this.fan2Cmd = on;
        return true;
      case "vent.auto":
        this.ventAuto = on;
        return true;
      case "fire.mode":
        this.fireMode = on;
        return true;
      case "setpoint.fan_start":
        this.fanStartSp = value;
        return true;
      case "sis.bypass":
        this.bypass = on;
        return true;
      case "sis.trip_current":
        this.etsTripSp = value;
        return true;
      default:
        return false;
    }
  }

  alarms(): PlantAlarm[] {
    const p = this.params;
    const t = this.tags;
    const out: PlantAlarm[] = [];
    if (this.energized && this.crewOnTrack) out.push({ id: "live-crew", text: "Traction power is on while a work crew is on the track", severity: "critical" });
    if (this.stranded > 0 && this.tunnelTemp > p.heatStress) out.push({ id: "heat-stress", text: `Passengers in stranded trains at risk: tunnel above ${p.heatStress} °C`, severity: "critical" });
    if (this.stranded > 0) out.push({ id: "stranded", text: `${this.stranded} train${this.stranded === 1 ? "" : "s"} stranded in the ${t.tunnel}`, severity: "high" });
    if (this.unprotected) out.push({ id: "unprotected", text: "A short circuit on the line would not be cleared", severity: "high" });
    if (this.bypass) out.push({ id: "ets-bypass", text: "Emergency trip system bypassed", severity: "high" });
    if (this.tunnelTemp > p.hotAlarm && !(this.stranded > 0 && this.tunnelTemp > p.heatStress)) out.push({ id: "tunnel-hot", text: `Tunnel above ${p.hotAlarm} °C`, severity: "medium" });
    if (this.tripped && !this.feederClosed) out.push({ id: "trip", text: `Feeder breaker ${t.feeder} tripped on overcurrent${this.recloseAt === undefined ? ", no more reclosing" : ""}`, severity: "medium" });
    if (this.fireMode) out.push({ id: "fire-mode", text: "Tunnel fire mode active: trains held at stations", severity: "medium" });
    if (!this.ventAuto && !this.fireMode) out.push({ id: "vent-manual", text: "Tunnel ventilation in manual", severity: "low" });
    if (this.possession) out.push({ id: "possession", text: "Work possession in force: line dead, no trains", severity: "low" });
    return out;
  }

  readouts(get: (signal: string) => number, ctx: { safety?: string }): Readout[] {
    const p = this.params;
    const t = this.tags;
    const moving = get("trains.moving");
    const stranded = get("trains.stranded");
    const volts = get("voltage.line");
    const amps = get("current.feeder");
    const closed = get("feeder.closed") === 1;
    const trip = get("alarm.trip") === 1;
    const temp = get("temp.tunnel") / 10;
    const fans = (get("fan1.running") === 1 ? 1 : 0) + (get("fan2.running") === 1 ? 1 : 0);
    const fire = get("fire.mode_active") === 1;
    const auto = get("vent.auto") === 1;
    const etsTrip = get("sis.tripped") === 1;
    const bypassed = get("sis.bypassed") === 1;
    const crew = get("crew.on_track") === 1;
    const ocSp = get("setpoint.overcurrent");
    const etsSp = get("sis.trip_current");
    const protectedOk = !(ocSp >= p.faultCurrent && (bypassed || etsSp >= p.faultCurrent));
    const live = volts > 0;
    const trainsText = crew ? "none in service (possession)" : fire ? "held at stations (fire mode)" : stranded > 0 ? `${stranded} STRANDED in the tunnel` : `${moving} moving`;
    return [
      { id: "trains", label: `Trains, ${t.line}`, text: trainsText, state: stranded > 0 ? "bad" : fire ? "warn" : crew ? "idle" : moving > 0 ? "ok" : "warn", strip: stranded > 0 ? `${stranded} trains stranded` : crew ? "Possession" : fire ? "Trains held" : `Trains ${moving} moving`, hmi: true },
      { id: "power", label: `Traction power ${t.substation}`, text: `${volts} V`, bar: (volts / p.lineVoltage) * 100, note: `feeder ${t.feeder} ${closed ? "closed" : trip ? "TRIPPED" : "open"}, ${amps} A, trips at ${ocSp} A`, state: live ? (crew ? "bad" : "ok") : crew ? "idle" : "bad", strip: live ? `${volts} V` : "Line dead", hmi: true },
      { id: "tunnel", label: "Tunnel temperature", text: `${temp.toFixed(1)} °C`, bar: (temp / 50) * 100, note: `first fan starts at ${(get("setpoint.fan_start") / 10).toFixed(1)} °C`, state: temp > p.heatStress ? "bad" : temp > p.hotAlarm ? "warn" : "ok", strip: `Tunnel ${temp.toFixed(1)} °C`, hmi: true },
      { id: "fans", label: `Tunnel fans ${t.fan1}, ${t.fan2}`, text: fans ? `${fans} running` : "off", note: fire ? "FIRE MODE" : auto ? "auto" : "MANUAL", state: fire ? "warn" : auto ? "ok" : "warn", hmi: true },
      { id: "ets", label: `Emergency trip${ctx.safety ? ` ${ctx.safety}` : ""}`, text: bypassed ? "BYPASSED" : etsTrip ? "tripped, holding power off" : "armed", state: bypassed ? "bad" : etsTrip ? (crew ? "ok" : "warn") : "ok", strip: bypassed ? "ETS bypassed" : etsTrip ? "ETS tripped" : "ETS armed", hmi: true },
      { id: "crew", label: "Work crew on the track", text: crew ? "yes" : "no", state: crew && live ? "bad" : crew ? "warn" : "ok", hmi: true },
      { id: "protection", label: "Short-circuit protection", text: protectedOk ? "OK" : "NOT PROTECTED", note: `feeder trips at ${ocSp} A, ETS at ${bypassed ? "(bypassed)" : `${etsSp} A`}, a short circuit draws ${p.faultCurrent} A`, state: protectedOk ? "ok" : "bad" },
    ];
  }

  notes(): string[] {
    const out: string[] = [];
    if (this.strandedSeconds > 0) out.push(`Trains stranded in the tunnel for ${Math.round(this.strandedSeconds)} s so far`);
    if (this.liveWithCrewSeconds > 0) out.push(`Line live with a crew on the track for ${Math.round(this.liveWithCrewSeconds)} s`);
    if (this.trips > 0) out.push(`Feeder ${this.tags.feeder} has tripped ${this.trips} time${this.trips === 1 ? "" : "s"}`);
    return out;
  }

  alarmDetail(id: string): string {
    const p = this.params;
    const t = this.tags;
    switch (id) {
      case "live-crew":
        return `${t.feeder} is closed and ${t.rectifier} is running, so the third rail is at ${Math.round(this.voltage)} V while a crew works on the track. The emergency trip system ${this.bypass ? "is bypassed" : "should be holding the rectifier off"}. Open the feeder now.`;
      case "heat-stress":
        return `${this.stranded} trains stopped in the tunnel with ${this.fansRunning} fan${this.fansRunning === 1 ? "" : "s"} running. The tunnel is at ${this.tunnelTemp.toFixed(1)} °C and the trains have no air conditioning without traction power.`;
      case "stranded":
        return `The line is dead (feeder ${this.feederClosed ? "closed" : "open"}, rectifier ${this.rectRunning ? "running" : "off"}), so trains stopped where they were. Passengers wait in the tunnel until power returns, and the tunnel warms without the piston effect of moving trains.`;
      case "unprotected":
        return `The feeder trips at ${this.overcurrentSp} A and the emergency trip system ${this.bypass ? "is bypassed" : `trips at ${this.etsTripSp} A`}. A short circuit draws about ${p.faultCurrent} A, so nothing would clear it: cables and the rail would overheat until something burns.`;
      case "ets-bypass":
        return "With the emergency trip system bypassed, nothing independent keeps the rectifier off while a crew is on the track, and nothing backs up the feeder protection on a short circuit.";
      case "tunnel-hot":
        return `Tunnel at ${this.tunnelTemp.toFixed(1)} °C with ${this.fansRunning} fan${this.fansRunning === 1 ? "" : "s"} running (ventilation ${this.fireMode ? "in fire mode" : this.ventAuto ? "auto" : "MANUAL"}).`;
      case "trip":
        return `The feeder current passed the ${this.overcurrentSp} A trip setting. Normal traffic draws up to about ${Math.round(p.trains * p.trainCurrent * 1.25)} A, more when trains start together after an outage.`;
      case "fire-mode":
        return "Fire mode runs both tunnel fans at full and the signalling holds every train at a station. It is meant for a fire in the tunnel. Without one, it only stops the service.";
      default:
        return "";
    }
  }

  snapshot(): Record<string, number | boolean> {
    const r = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
    return {
      voltage: Math.round(this.voltage),
      energized: this.energized,
      feederClosed: this.feederClosed,
      feederTripped: this.tripped && !this.feederClosed,
      trips: this.trips,
      current: Math.round(this.current),
      trainsMoving: this.moving,
      trainsStranded: this.stranded,
      strandedSeconds: r(this.strandedSeconds, 1),
      tunnelTemp: r(this.tunnelTemp, 1),
      fansRunning: this.fansRunning,
      ventAuto: this.ventAuto,
      fireMode: this.fireMode,
      etsTripped: this.etsTripped,
      etsBypassed: this.bypass,
      crewOnTrack: this.crewOnTrack,
      possession: this.possession,
      liveWithCrewSeconds: r(this.liveWithCrewSeconds, 1),
      heatStressSeconds: r(this.heatStressSeconds, 1),
      overcurrentSetpoint: this.overcurrentSp,
      etsTripCurrent: this.etsTripSp,
      fanStartSetpoint: this.fanStartSp,
      protected: !this.unprotected,
    };
  }
}

export const METRO_LINE: ProcessModelType = {
  model: "metro-line",
  description: "Traction power and tunnel ventilation for a metro line section: rectifier, DC feeder breaker with overcurrent protection, trains, tunnel fans with fire mode, and an emergency trip system.",
  signals: SIGNALS,
  params: PARAMS,
  tags: TAGS,
  check(p) {
    const e: string[] = [];
    const peak = p.trains * p.trainCurrent * 1.25 * 1.5;
    if (p.overcurrent <= peak) e.push(`overcurrent must be above the current of trains starting together (about ${Math.round(peak)} A), or the feeder trips in normal service`);
    if (p.overcurrent >= p.faultCurrent) e.push("overcurrent must be below faultCurrent, or the feeder never clears a short circuit");
    if (p.etsTrip >= p.faultCurrent) e.push("etsTrip must be below faultCurrent, or the emergency trip system never backs up the feeder");
    if (!(p.fanStart < p.hotAlarm && p.hotAlarm < p.heatStress)) e.push("temperatures must be in order: fanStart < hotAlarm < heatStress");
    return e;
  },
  create: (params, tags) => new MetroLine(params, tags),
};
