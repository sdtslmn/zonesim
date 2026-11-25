import { describe, expect, it } from "vitest";
import { WATER_TANK, WaterTank, Controller, builtinSite, GAS_COMPRESSOR, GasCompressor, DC_COOLING, DcCooling, METRO_LINE, MetroLine } from "../src/index.js";

const site = builtinSite();

function tank(overrides: Record<string, number> = {}): WaterTank {
  return WATER_TANK.create({ ...site.process.params, ...overrides }, site.process.tags) as WaterTank;
}

function run(p: WaterTank, seconds: number): void {
  for (let t = 0; t < seconds; t += 0.5) p.step(0.5);
}

describe("water tank process", () => {
  it("keeps the tank between the start and stop levels in auto mode", () => {
    const p = tank();
    let min = 100;
    let max = 0;
    for (let t = 0; t < 1200; t += 0.5) {
      p.step(0.5);
      if (t > 60) {
        min = Math.min(min, p.level);
        max = Math.max(max, p.level);
      }
    }
    expect(min).toBeGreaterThan(38);
    expect(max).toBeLessThan(82);
    expect(p.overflowSeconds).toBe(0);
    expect(p.pumpStarts).toBeGreaterThan(3);
  });

  it("follows the parameters of the site", () => {
    const p = tank({ startLevel: 20, stopLevel: 60 });
    let max = 0;
    for (let t = 0; t < 1200; t += 0.5) {
      p.step(0.5);
      if (t > 60) max = Math.max(max, p.level);
    }
    expect(max).toBeLessThan(62);
    expect(p.get("setpoint.stop")).toBe(600);
  });

  it("lets the safety system stop the pump at high-high when the PLC fails", () => {
    const p = tank();
    p.set("control.auto", 0);
    p.set("pump.command", 1);
    run(p, 120);
    expect(p.sisTrip).toBe(true);
    expect(p.level).toBeLessThan(96);
    expect(p.overflowSeconds).toBe(0);
  });

  it("overflows when the safety trip is bypassed", () => {
    const p = tank();
    p.set("control.auto", 0);
    p.set("pump.command", 1);
    p.set("sis.bypass", 1);
    run(p, 120);
    expect(p.overflowing).toBe(true);
    expect(p.overflowSeconds).toBeGreaterThan(0);
    expect(p.alarms().map((a) => a.id)).toContain("overflow");
  });

  it("loses chlorine when dosing stops", () => {
    const p = tank();
    p.set("dosing.enable", 0);
    run(p, 120);
    expect(p.chlorine).toBeLessThan(0.5);
    expect(p.alarms().map((a) => a.id)).toContain("cl-low");
  });

  it("refuses to write read-only signals", () => {
    const p = tank();
    expect(p.set("level", 999)).toBe(false);
    expect(p.set("nope", 1)).toBe(false);
  });

  it("checks parameter combinations", () => {
    expect(WATER_TANK.check({ ...site.process.params, startLevel: 80, stopLevel: 40 }).length).toBeGreaterThan(0);
    expect(WATER_TANK.check(site.process.params)).toEqual([]);
  });
});

describe("controller", () => {
  it("answers Modbus through its point map", () => {
    const p = tank();
    const plc = new Controller("plc-1", site.devices["plc-1"], p);
    expect(plc.modbus({ fc: 3, addr: 0, count: 3 })).toEqual({ ok: true, values: [400, 800, 150] });
    expect(plc.modbus({ fc: 4, addr: 1, count: 5 })).toEqual({ ok: false, exception: 2 });
    expect(plc.modbus({ fc: 8, addr: 0 })).toEqual({ ok: false, exception: 1 });
    expect(plc.modbus({ fc: 5, addr: 1, values: [2] })).toEqual({ ok: false, exception: 3 });
    expect(plc.modbus({ fc: 16, addr: 0, values: [300, 700] }).ok).toBe(true);
    expect([p.get("setpoint.start"), p.get("setpoint.stop")]).toEqual([300, 700]);
    expect(plc.find("setpoint.stop")).toMatchObject({ table: "hr", point: { addr: 1 } });
    const sis = new Controller("sis-1", site.devices["sis-1"], p);
    expect(sis.modbus({ fc: 43, addr: 0 }).deviceId?.product).toBe("ZS-SIS 20");
  });
});

const defaults = (m: { params: { name: string; default: number }[] }) => Object.fromEntries(m.params.map((p) => [p.name, p.default]));
const steps = (m: { step(dt: number): void }, seconds: number) => {
  for (let t = 0; t < seconds; t += 0.5) m.step(0.5);
};

describe("gas compressor process", () => {
  const gas = () => GAS_COMPRESSOR.create(defaults(GAS_COMPRESSOR), GAS_COMPRESSOR.tags) as GasCompressor;

  it("holds the discharge pressure with the anti-surge valve recycling", () => {
    const g = gas();
    steps(g, 300);
    expect(g.pd).toBeCloseTo(65, 0);
    expect(g.recycle).toBeGreaterThan(5);
    expect(g.surgeSeconds).toBe(0);
  });

  it("follows a new setpoint without surging", () => {
    const g = gas();
    g.set("setpoint.discharge", 600);
    steps(g, 200);
    expect(g.pd).toBeCloseTo(60, 0);
    expect(g.surgeSeconds).toBe(0);
  });

  it("surges and trips when the anti-surge valve is forced shut", () => {
    const g = gas();
    g.set("antisurge.auto", 0);
    g.set("setpoint.recycle", 0);
    steps(g, 30);
    expect(g.surgeSeconds).toBeGreaterThan(5);
    expect(g.vibrationTrip).toBe(true);
    expect(g.get("compressor.run")).toBe(0);
  });

  it("trips on high-high pressure, or vents when the trip is bypassed", () => {
    const g = gas();
    g.set("control.auto", 0);
    g.set("setpoint.speed", 1000);
    steps(g, 90);
    expect(g.get("compressor.run")).toBe(0);
    expect(g.running).toBe(false);
    expect(g.ventSeconds).toBe(0);
    const v = gas();
    v.set("control.auto", 0);
    v.set("setpoint.speed", 1000);
    v.set("sis.bypass", 1);
    steps(v, 150);
    expect(v.ventSeconds).toBeGreaterThan(10);
    expect(v.pd).toBeLessThan(81);
  });

  it("reports metered flow with the meter factor", () => {
    const g = gas();
    g.set("meter.factor", 10500);
    steps(g, 5);
    expect(g.get("meter.flow")).toBe(Math.round(g.get("flow") * 1.05));
  });
});

describe("data centre cooling process", () => {
  const dc = () => DC_COOLING.create(defaults(DC_COOLING), DC_COOLING.tags) as DcCooling;

  it("runs one chiller and keeps the other as a spare", () => {
    const d = dc();
    steps(d, 120);
    expect(d.running1 && !d.running2).toBe(true);
    expect(d.coldAisle).toBeCloseTo(24, 0);
  });

  it("starts the spare when the duty chiller is disabled", () => {
    const d = dc();
    d.set("chiller1.enable", 0);
    steps(d, 10);
    expect(d.running2).toBe(true);
  });

  it("overheats and shuts the servers down when the pumps stop", () => {
    const d = dc();
    d.set("pump.run", 0);
    steps(d, 400);
    expect(d.itShutdown).toBe(true);
    expect(d.get("load.it")).toBeLessThan(1200);
  });

  it("does not release the agent while isolated", () => {
    const d = dc();
    d.set("fire.isolate", 1);
    d.set("fire.release", 1);
    steps(d, 5);
    expect(d.released).toBe(false);
    d.set("fire.isolate", 0);
    steps(d, 5);
    expect(d.released).toBe(true);
    expect(d.get("load.it")).toBe(0);
  });
});

describe("metro line process", () => {
  const metro = () => METRO_LINE.create(defaults(METRO_LINE), METRO_LINE.tags) as MetroLine;

  it("runs every train on a live line with the fans off", () => {
    const m = metro();
    steps(m, 300);
    expect(m.moving).toBe(6);
    expect(m.voltage).toBeGreaterThan(650);
    expect(m.tunnelTemp).toBeLessThan(30);
    expect(m.fansRunning).toBe(0);
    expect(m.alarms()).toHaveLength(0);
  });

  it("strands trains in the tunnel when the feeder opens, and the tunnel heats without fans", () => {
    const m = metro();
    m.set("vent.auto", 0);
    m.set("feeder.command", 0);
    steps(m, 360);
    expect(m.stranded).toBe(4);
    expect(m.tunnelTemp).toBeGreaterThan(40);
    expect(m.alarms().map((a) => a.id)).toContain("heat-stress");
    m.set("feeder.command", 1);
    steps(m, 30);
    expect(m.moving).toBe(6);
    expect(m.stranded).toBe(0);
  });

  it("keeps the tunnel cool with the fans in auto while trains are stranded", () => {
    const m = metro();
    m.set("feeder.command", 0);
    steps(m, 600);
    expect(m.fansRunning).toBeGreaterThan(0);
    expect(m.tunnelTemp).toBeLessThan(32);
  });

  it("trips on a low overcurrent setting, recloses once, then locks out", () => {
    const m = metro();
    m.set("setpoint.overcurrent", 1500);
    steps(m, 60);
    expect(m.trips).toBe(2);
    expect(m.feederClosed).toBe(false);
    expect(m.get("alarm.trip")).toBe(1);
    m.set("setpoint.overcurrent", 5000);
    m.set("feeder.command", 1);
    steps(m, 60);
    expect(m.feederClosed).toBe(true);
    expect(m.trips).toBe(2);
  });

  it("keeps the rail dead during a possession, unless the trip system is bypassed", () => {
    const m = metro();
    m.set("possession", 1);
    steps(m, 10);
    expect(m.energized).toBe(false);
    expect(m.etsTripped).toBe(true);
    expect(m.moving).toBe(0);
    // The controller refuses to close; the crew is still on the track if the possession is cleared.
    m.set("possession", 0);
    m.set("feeder.command", 1);
    steps(m, 5);
    expect(m.feederClosed).toBe(true);
    expect(m.energized).toBe(false);
    m.set("sis.bypass", 1);
    steps(m, 5);
    expect(m.energized).toBe(true);
    expect(m.alarms()[0].id).toBe("live-crew");
  });

  it("holds trains at stations in fire mode", () => {
    const m = metro();
    m.set("fire.mode", 1);
    steps(m, 30);
    expect(m.moving).toBe(0);
    expect(m.stranded).toBe(0);
    expect(m.fansRunning).toBe(2);
  });

  it("reports when a short circuit would not be cleared", () => {
    const m = metro();
    m.set("setpoint.overcurrent", 20000);
    expect(m.unprotected).toBe(false);
    m.set("sis.bypass", 1);
    expect(m.unprotected).toBe(true);
    expect(m.snapshot().protected).toBe(false);
  });
});
