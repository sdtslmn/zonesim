import { describe, expect, it } from "vitest";
import { sandbox } from "./helpers.js";
import { Sim, builtinSite } from "../src/index.js";

describe("HMI", () => {
  it("knows where it reads each signal and what it may write", () => {
    const { sim } = sandbox();
    expect(sim.hmiDevices()).toEqual(["plc-1", "sis-1"]);
    expect(sim.hmiSource("level")).toEqual({ device: "plc-1", table: "ir", addr: 0, tag: "LT_101" });
    expect(sim.hmiSource("sis.tripped")?.device).toBe("sis-1");
    expect(sim.hmiWritable("setpoint.stop")?.addr).toBe(1);
    // The safety system is read-only from the HMI.
    expect(sim.hmiWritable("sis.bypass")).toBeUndefined();
  });

  it("writes through the network from the HMI host, without an IDS alert", () => {
    const { sim } = sandbox();
    const a = sim.hmiWrite("setpoint.stop", 700, "T-101 stop level 70 %");
    expect(a.ok).toBe(true);
    expect(a.detail).toBe("fc 6 hr 1 (LSP_STOP) = 700");
    expect(sim.plant.get("setpoint.stop")).toBe(700);
    expect(sim.hmiValues["setpoint.stop"]).toBe(700);
    expect(sim.alerts.filter((x) => x.source === "ids")).toHaveLength(0);
    expect(sim.events.at(-1)).toMatchObject({ src: "hmi-01", dst: "plc-1", service: "modbus", fc: 6 });
    expect(sim.hmiActions).toHaveLength(1);
  });

  it("fails like a real HMI when the network blocks it", async () => {
    const { sim, run } = sandbox();
    await run("zone create control");
    await run("zone add control plc-1");
    const a = sim.hmiWrite("dosing.enable", 0, "P-201 stop");
    expect(a).toMatchObject({ ok: false, result: "no response from plc-1" });
    expect(a.detail).toContain("no conduit between zones site and control");
    expect(sim.plant.get("dosing.enable")).toBe(1);
    // Reads only: the write is dropped at the conduit.
    await run("conduit create site-control site control");
    await run("fw allow site-control from hmi-01 to plc-1 modbus fc read");
    expect(sim.hmiWrite("dosing.enable", 0, "P-201 stop").detail).toContain("function code 5 is not allowed");
  });

  it("goes stale when the HMI loses its link", async () => {
    const { sim, run } = sandbox();
    expect(sim.hmiFresh("plc-1")).toBe(true);
    await run("ssh sw-01 'enable; configure; interface 1/5; shutdown'");
    sim.settle(10);
    expect(sim.hmiFresh("plc-1")).toBe(false);
    expect(sim.hmiWrite("pump.command", 1, "P-101 start").ok).toBe(false);
  });

  it("works on the other plants", () => {
    const gas = new Sim({ clock: () => 0, site: builtinSite("gas-compressor-station") });
    gas.settle(4);
    expect(gas.hmiDevices()).toEqual(["ucp-1", "esd-1"]);
    expect(gas.hmiWrite("setpoint.discharge", 620, "PIC-101 setpoint 62 bar").ok).toBe(true);
    // The flow computer is not polled by the HMI.
    expect(gas.hmiSource("meter.factor")).toBeUndefined();
    const dc = new Sim({ clock: () => 0, site: builtinSite("data-centre-cooling") });
    dc.settle(4);
    expect(dc.hmiDevices()).toEqual(["cpc-1", "fp-1", "pm-1"]);
    expect(dc.hmiWritable("fire.isolate")).toBeUndefined();
    expect(dc.hmiWrite("setpoint.chw", 160, "CHWS setpoint 16 °C").ok).toBe(true);
  });
});

describe("hmi actions command", () => {
  it("lists operator actions", async () => {
    const { sim, run } = sandbox();
    expect((await run("hmi actions")).out).toContain("No operator actions");
    sim.hmiWrite("setpoint.stop", 750, "T-101 stop level 75.0 %");
    const r = await run("hmi actions");
    expect(r.out).toContain("T-101 stop level 75.0 %");
    expect(r.out).toContain("fc 6 hr 1 (LSP_STOP) = 750");
  });
});

describe("operator labs on the HMI", () => {
  it("lab 3 passes when the operator uses the HMI screen", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { parseLab, resolveLab, LabSession, MemoryFS } = await import("../src/index.js");
    const raw = parseLab(readFileSync(join(__dirname, "../../../labs/riverside-water/beginner/b03-operator-write.yaml"), "utf8"), "b03");
    const lab = resolveLab(raw, builtinSite()).lab!;
    const session = new LabSession(lab, new MemoryFS(), { clock: () => 0 });
    await session.setup();
    expect(session.sim.hmiWrite("setpoint.stop", 750, "T-101 stop level 75.0 %").ok).toBe(true);
    const results = await session.check();
    expect(results.every((r) => r.passed), JSON.stringify(results)).toBe(true);
  });
});
