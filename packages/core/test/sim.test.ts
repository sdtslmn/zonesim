import { describe, expect, it } from "vitest";
import { sandbox, ZONES } from "./helpers.js";

describe("simulation", () => {
  it("raises an IDS alert for an unauthorized write, not for the HMI", async () => {
    const s = sandbox();
    await s.run("ssh hmi-01 modbus write plc-1 hr 1 750");
    expect(s.sim.alerts.filter((a) => a.title.includes("Unauthorized"))).toHaveLength(0);
    await s.run("ssh corp-pc modbus write plc-1 coil 1 0");
    const a = s.sim.alerts.find((x) => x.title.includes("Unauthorized"));
    expect(a?.src).toBe("corp-pc");
    expect(a?.detail).toContain("10.10.40.21");
  });

  it("flags any write to the safety system as critical", async () => {
    const s = sandbox();
    await s.run("ssh ews-01 modbus write sis-1 coil 0 1");
    expect(s.sim.alerts.some((a) => a.severity === "critical" && a.dst === "sis-1")).toBe(true);
  });

  it("detects a network scan", async () => {
    const s = sandbox();
    const r = await s.run("ssh corp-pc nmap 10.10.10.0/24");
    expect(r.out).toContain("Scan report for plc-1");
    expect(r.out).toMatch(/502\/tcp\s+open\s+modbus/);
    expect(s.sim.alerts.some((a) => a.title === "Network scan" && a.src === "corp-pc")).toBe(true);
  });

  it("blinds the HMI when its Modbus traffic is blocked", async () => {
    const s = sandbox();
    await s.run("zone create control");
    await s.run("zone add control plc-1");
    s.sim.settle(10);
    expect(s.sim.hmiOnline).toBe(false);
    expect(s.sim.alerts.some((a) => a.title.includes("HMI lost communication"))).toBe(true);
    expect(s.sim.requiredFlows().find((f) => f.flow.id === "hmi-plc")?.ok).toBe(false);
  });

  it("passes every design check with the reference design, and fails most as found", async () => {
    const s = sandbox();
    expect(s.sim.risks().filter((r) => r.ok).length).toBeLessThan(4);
    expect(s.sim.requiredFlows().every((f) => f.ok)).toBe(true);
    for (const c of [
      ...ZONES,
      "conduit create ops-control operations control",
      "fw allow ops-control from historian to plc-1 modbus fc 3,4",
      "conduit create ops-safety operations safety",
      "fw allow ops-safety from historian to sis-1 modbus fc 2,4",
      "conduit create control-safety control safety",
      "fw allow control-safety from hmi-01 to sis-1 modbus fc read",
      "conduit create ops-dmz operations dmz",
      "fw allow ops-dmz from historian to hist-dmz https",
      "conduit create ent-dmz enterprise dmz",
      "fw allow ent-dmz from corp-pc to hist-dmz https",
      "conduit create inet-dmz internet dmz",
      "fw allow inet-dmz from vendor-laptop to jump-01 rdp",
      "conduit create dmz-control dmz control",
      "fw allow dmz-control from jump-01 to ews-01 rdp",
      "host config jump-01 mfa=on",
    ]) {
      const r = await s.run(c);
      expect(r.code, `${c}: ${r.err}`).toBe(0);
    }
    expect(s.sim.requiredFlows().filter((f) => !f.ok)).toEqual([]);
    expect(s.sim.risks().filter((r) => !r.ok)).toEqual([]);
    s.sim.settle(30);
    expect(s.sim.hmiOnline).toBe(true);
  });

  it("logs blocked traffic in the firewall log", async () => {
    const s = sandbox();
    for (const c of ZONES) await s.run(c);
    await s.run("conduit create ops-control operations control");
    await s.run("fw allow ops-control from historian to plc-1 modbus fc 3,4");
    const r = await s.run("ssh historian modbus write plc-1 hr 1 900");
    expect(r.code).toBe(1);
    expect(r.err).toContain("timed out");
    const log = await s.run("fw log");
    expect(log.out).toMatch(/historian\s+plc-1\s+modbus fc 6\s+function code 6 is not allowed/);
  });
});
