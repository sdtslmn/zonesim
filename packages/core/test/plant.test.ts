import { describe, expect, it } from "vitest";
import { Plant } from "../src/plant.js";

function run(p: Plant, seconds: number): void {
  for (let t = 0; t < seconds; t += 0.5) p.step(0.5);
}

describe("plant process", () => {
  it("keeps the tank between the start and stop levels in auto mode", () => {
    const p = new Plant();
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

  it("lets the safety system stop the pump at high-high when the PLC fails", () => {
    const p = new Plant();
    p.plcCoils[2] = false; // manual
    p.plcCoils[0] = true; // pump forced on
    run(p, 120);
    expect(p.sisTrip).toBe(true);
    expect(p.level).toBeLessThan(96);
    expect(p.overflowSeconds).toBe(0);
  });

  it("overflows when the safety trip is bypassed", () => {
    const p = new Plant();
    p.plcCoils[2] = false;
    p.plcCoils[0] = true;
    p.sisCoils[0] = true;
    run(p, 120);
    expect(p.overflowing).toBe(true);
    expect(p.overflowSeconds).toBeGreaterThan(0);
    expect(p.alarms().map((a) => a.id)).toContain("overflow");
  });

  it("loses chlorine when dosing stops", () => {
    const p = new Plant();
    p.plcCoils[1] = false;
    run(p, 120);
    expect(p.chlorine).toBeLessThan(0.5);
    expect(p.alarms().map((a) => a.id)).toContain("cl-low");
  });

  it("answers Modbus like a controller", () => {
    const p = new Plant();
    expect(p.modbus("plc-1", { fc: 3, addr: 0, count: 3 })).toEqual({ ok: true, values: [400, 800, 150] });
    expect(p.modbus("plc-1", { fc: 4, addr: 1, count: 5 })).toEqual({ ok: false, exception: 2 });
    expect(p.modbus("plc-1", { fc: 8, addr: 0 })).toEqual({ ok: false, exception: 1 });
    expect(p.modbus("plc-1", { fc: 5, addr: 1, values: [2] })).toEqual({ ok: false, exception: 3 });
    expect(p.modbus("plc-1", { fc: 16, addr: 0, values: [300, 700] }).ok).toBe(true);
    expect(p.plcHr.slice(0, 2)).toEqual([300, 700]);
    expect(p.modbus("sis-1", { fc: 43, addr: 0 }).deviceId?.product).toBe("ZS-SIS 20");
  });
});
