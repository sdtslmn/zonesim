import { describe, expect, it } from "vitest";
import { Sim, MemoryFS, createShell, builtinSite, loadSiteFile, type IO } from "../src/index.js";

function metro() {
  const sim = new Sim({ clock: () => 0, site: builtinSite("metro-line") });
  const shell = createShell(sim, new MemoryFS());
  sim.settle(6);
  const run = async (cmd: string) => {
    let out = "";
    const io: IO = { stdout: (t) => (out += t), stderr: (t) => (out += t), sleep: async (ms) => sim.settle(ms / 1000) };
    const code = await shell.exec(cmd, io);
    return { code, out: out.replace(/\x1b\[[0-9;]*m/g, "") };
  };
  return { sim, run };
}

describe("passive backup centre", () => {
  it("keeps the BOCC silent while the OCC has control", () => {
    const { sim } = metro();
    sim.settle(30);
    expect(sim.events.some((e) => e.src === "bocc-scada" && e.dst === "tps-1")).toBe(false);
    expect(sim.hmiHost).toBe("occ-scada");
    expect(sim.requiredFlows().map((f) => f.flow.id)).not.toContain("bocc-plc");
    expect(sim.standbyFlows().map((f) => f.flow.id)).toEqual(["bocc-plc", "bocc-tvs", "bocc-sis"]);
  });

  it("flags the as-found BOCC link: passive in name only", () => {
    const { sim } = metro();
    const check = sim.risks().find((r) => r.id === "standby-passive")!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("bocc-scada can send function code 3 to tps-1");
  });

  it("raises an IDS alert on a write from the passive BOCC", async () => {
    const { sim, run } = metro();
    await run("ssh bocc-scada modbus write tps-1 coil 0 1");
    expect(sim.alerts.find((a) => a.title === "Modbus write from the passive BOCC")).toBeDefined();
  });

  it("takes over: the OCC hosts stop and the BOCC runs the screen and polls", async () => {
    const { sim, run } = metro();
    const r = await run("takeover start");
    expect(r.out).toContain("Every flow the BOCC needs works");
    expect(sim.takeover).toBe(true);
    expect(sim.net.host("occ-scada")?.link).toBe(false);
    expect(sim.hmiHost).toBe("bocc-scada");
    sim.settle(10);
    expect(sim.events.some((e) => e.src === "bocc-scada" && e.dst === "tps-1" && e.delivered)).toBe(true);
    expect(sim.events.filter((e) => e.t > 7).some((e) => e.src === "occ-scada")).toBe(false);
    expect(sim.hmiFresh("tps-1")).toBe(true);
    expect(sim.hmiWrite("setpoint.fan_start", 280, "fan start 28").ok).toBe(true);
    expect(sim.alerts.some((a) => a.title.includes("passive BOCC"))).toBe(false);
    expect(sim.requiredFlows().map((f) => f.flow.id).sort()).toEqual(["bocc-plc", "bocc-sis", "bocc-tvs"]);
    await run("takeover end");
    expect(sim.hmiHost).toBe("occ-scada");
    expect(sim.net.host("occ-scada")?.link).toBe(true);
  });

  it("counts disabled rules as ready, and blocks with them until they are enabled", async () => {
    const { sim, run } = metro();
    await run("zone create station --sl 3");
    await run("zone add station tps-1 tvc-1 ets-1");
    await run("conduit create bocc-station bocc station");
    await run("fw allow bocc-station from bocc-scada to tps-1 modbus fc 1,2,3,4,5,6");
    await run("fw allow bocc-station from bocc-scada to tvc-1 modbus fc 1,2,3,4,5,6");
    await run("fw allow bocc-station from bocc-scada to ets-1 modbus fc 2,4");
    for (const n of [1, 2, 3]) await run(`fw disable bocc-station ${n}`);
    expect((await run("fw list bocc-station")).out).toContain("disabled");
    expect(sim.risks().find((r) => r.id === "takeover-ready")?.ok).toBe(true);
    expect(sim.net.evaluate(sim.net.host("bocc-scada")!, sim.net.host("tps-1")!, "modbus", 5).allowed).toBe(false);
    const start = await run("takeover start");
    expect(start.out).toContain("blocked");
    sim.settle(10);
    expect(sim.hmiFresh("tps-1")).toBe(false);
    for (const n of [1, 2, 3]) await run(`fw enable bocc-station ${n}`);
    sim.settle(5);
    expect(sim.hmiFresh("tps-1")).toBe(true);
    expect(sim.requiredFlows().every((f) => f.ok)).toBe(true);
  });

  it("checks the standby section of a site file", () => {
    const bad = loadSiteFile(`schema: zonesim-site/1\nid: x\nname: X\nextends: metro-line\nstandby: { backup: nobody, lost: [occ-scada] }\n`);
    expect(bad.errors.join(" ")).toContain('standby.backup: there is no host "nobody"');
    const noHmi = loadSiteFile(`schema: zonesim-site/1\nid: y\nname: Y\nextends: metro-line\nstandby: { lost: [ews-1] }\n`);
    expect(noHmi.errors.join(" ")).toContain("standby.lost must include the HMI host occ-scada");
  });
});
