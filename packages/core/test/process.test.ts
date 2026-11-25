import { describe, expect, it } from "vitest";
import { WATER_TANK, WaterTank, Controller, builtinSite } from "../src/index.js";

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
