import { describe, expect, it } from "vitest";
import { Sim, MemoryFS, createShell, builtinSite, type IO } from "../src/index.js";

function plant(site = "riverside-water") {
  const sim = new Sim({ clock: () => 0, site: builtinSite(site) });
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

describe("IDS sensor", () => {
  it("learns the plant's polling and data flows at commissioning, so normal traffic raises nothing", () => {
    const { sim } = plant();
    sim.settle(60);
    expect(sim.sensor.mode).toBe("protecting");
    expect(sim.sensor.baseline.length).toBeGreaterThan(5);
    expect(sim.sensor.links().every((l) => l.learned && !l.newFcs.length)).toBe(true);
    expect(sim.alerts.filter((a) => a.anomaly)).toEqual([]);
  });

  it("builds an asset inventory, and knows controller identity from commissioning", () => {
    const { sim } = plant();
    const assets = sim.sensor.assets(sim.net.hosts);
    const plc = assets.find((a) => a.name === "plc-1")!;
    expect(plc.type).toBe("controller");
    expect(plc.identity?.revision).toBe(sim.devices.get("plc-1")!.def.revision);
    expect(plc.serves).toContain("modbus");
    expect(assets.find((a) => a.name === "sis-1")?.type).toBe("safety controller");
    expect(assets.find((a) => a.name === "hmi-01")?.peers).toContain("plc-1");
  });

  it("learns a controller's identity from a device identification reply on the wire", async () => {
    const { sim, run } = plant();
    expect(sim.sensor.identities.has("sis-1")).toBe(false);
    await run("ssh ews-01 modbus info sis-1");
    expect(sim.sensor.identities.get("sis-1")?.t).toBe(sim.t);
  });

  it("raises one New link alert per source, listing every new link, and maps ATT&CK", async () => {
    const { sim, run } = plant();
    await run("ssh corp-pc modbus read plc-1 hr 0");
    await run("ssh corp-pc modbus write plc-1 coil 0 0");
    const nl = sim.alerts.filter((a) => a.title === "New link");
    expect(nl).toHaveLength(1);
    expect(nl[0].severity).toBe("high");
    expect(nl[0].anomaly?.map((l) => l.fc)).toEqual([3, 5]);
    expect(nl[0].detail).toContain("corp-pc → plc-1 modbus fc 5 (write single coil)");
    const write = sim.alerts.find((a) => a.title.startsWith("Unauthorized Modbus write"))!;
    expect(write.attack).toEqual(["T0855", "T0831"]);
    expect(write.advice).toContain("block it from plc-1");
  });

  it("raises New function code when a known host uses a function code outside the baseline", async () => {
    const { sim, run } = plant();
    await run("ssh hmi-01 modbus write sis-1 coil 0 1");
    const a = sim.alerts.find((x) => x.title === "New function code")!;
    expect(a.src).toBe("hmi-01");
    expect(a.severity).toBe("high");
    expect(a.detail).toContain("fc 5 (write single coil)");
    expect(sim.alerts.some((x) => x.title === "Modbus write to the safety system" && x.attack?.includes("T0880"))).toBe(true);
  });

  it("learns everything in learning mode, so an intrusion becomes normal", async () => {
    const { sim, run } = plant();
    await run("ids mode learning");
    await run("ssh corp-pc modbus write plc-1 coil 0 0");
    await run("ids mode protecting");
    await run("ssh corp-pc modbus write plc-1 coil 0 1");
    expect(sim.alerts.some((a) => a.anomaly)).toBe(false);
    // Rule alerts do not depend on the baseline.
    expect(sim.alerts.some((a) => a.title.startsWith("Unauthorized Modbus write"))).toBe(true);
    const learned = sim.sensor.baseline.find((b) => b.src === "corp-pc" && b.dst === "plc-1")!;
    expect(learned.how).toBe("learning");
    const r = await run("ids baseline corp-pc");
    expect(r.out).toMatch(new RegExp(`${learned.id}\\s+corp-pc\\s+plc-1\\s+modbus\\s+5\\s+learning`));
    await run(`ids baseline delete ${learned.id}`);
    await run("ssh corp-pc modbus write plc-1 coil 0 1");
    expect(sim.alerts.some((a) => a.title === "New link" && a.src === "corp-pc")).toBe(true);
  });

  it("closes an anomaly alert when it is learned, and stays quiet after", async () => {
    const { sim, run } = plant();
    await run("ssh ews-01 modbus read hmi-01 hr 0");
    const a = sim.alerts.find((x) => x.title === "New link")!;
    const r = await run(`ids learn ${a.id}`);
    expect(r.out).toContain("ews-01 → hmi-01 modbus fc 3");
    expect(a.acked && a.learned).toBe(true);
    await run("ssh ews-01 modbus read hmi-01 hr 0");
    expect(sim.alerts.filter((x) => x.title === "New link")).toHaveLength(1);
    const rule = sim.alerts.find((x) => !x.anomaly);
    if (rule) expect((await run(`ids learn ${rule.id}`)).out).toContain("not an anomaly alert");
  });

  it("does not count probes nobody answers as services an asset offers", async () => {
    const { sim, run } = plant();
    await run("ssh corp-pc nmap -p 22 plc-1");
    expect(sim.sensor.links().some((l) => l.src === "corp-pc" && l.dst === "plc-1" && l.service === "ssh")).toBe(true);
    expect(sim.sensor.assets(sim.net.hosts).find((a) => a.name === "plc-1")?.serves).not.toContain("ssh");
  });

  it("shows sensor, links and assets in the terminal", async () => {
    const { run } = plant("metro-line");
    expect((await run("ids")).out).toContain("Mode:      protecting");
    expect((await run("assets")).out).toMatch(/tps-1\s+172\.21\.10\.10\s+controller\s+Voltline Traction VT-PCS 500\s+3\.2\.0/);
    expect((await run("assets ets-1")).out).toContain("not seen yet");
    await run("ssh corp-pc modbus read tvc-1 ir 0");
    expect((await run("ids links --new")).out).toMatch(/corp-pc\s+tvc-1\s+modbus\s+4\s+1\s+\S+\s+new link/);
    expect((await run("alerts show A-1001")).out).toContain("What to check");
  });
});
