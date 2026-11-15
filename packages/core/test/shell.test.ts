import { describe, expect, it } from "vitest";
import { sandbox } from "./helpers.js";
import { tokenize } from "../src/shell.js";

describe("shell", () => {
  it("tokenizes quotes and operators", () => {
    expect(tokenize(`echo "a b" 'c|d' | grep x && ls > f.txt`).map((t) => t.value)).toEqual(["echo", "a b", "c|d", "|", "grep", "x", "&&", "ls", ">", "f.txt"]);
  });

  it("pipes, filters and redirects", async () => {
    const s = sandbox();
    expect((await s.run("hosts | grep -c 10.10.")).out.trim()).toBe("8");
    await s.run("hosts | grep plc-1 > plc.txt");
    expect(s.fs.readFile("plc.txt")).toContain("10.10.10.10");
    await s.run("echo one >> notes.txt; echo two >> notes.txt");
    expect((await s.run("cat notes.txt | wc -l")).out.trim()).toBe("2");
    expect((await s.run("false && echo no || echo yes")).out).toBe("yes\n");
  });

  it("knows where commands run", async () => {
    const s = sandbox();
    const r = await s.run("modbus read plc-1 hr 0");
    expect(r.code).toBe(1);
    expect(r.err).toContain("ssh hmi-01");
    await s.run("ssh hmi-01");
    expect(s.shell.host?.name).toBe("hmi-01");
    const z = await s.run("zone list");
    expect(z.err).toContain("console command");
    expect((await s.run("modbus read plc-1 hr 1")).out).toMatch(/hr 1\s+800/);
    await s.run("exit");
    expect(s.shell.host).toBeUndefined();
  });

  it("crosses the network for rdp and ssh between hosts", async () => {
    const s = sandbox();
    await s.run("ssh vendor-laptop");
    expect((await s.run("rdp ews-01")).code).toBe(0);
    expect(s.shell.host?.name).toBe("ews-01");
    expect((await s.run("modbus read plc-1 ir 0")).code).toBe(0);
    await s.run("exit");
    expect(s.shell.host?.name).toBe("vendor-laptop");
    expect((await s.run("rdp plc-1")).err).toContain("timed out");
  });

  it("does not let you log in to a controller", async () => {
    const s = sandbox();
    const r = await s.run("ssh plc-1");
    expect(r.code).toBe(1);
    expect(r.err).toContain("controller");
  });

  it("fast-forwards the plant with wait", async () => {
    const s = sandbox();
    const t0 = s.sim.t;
    await s.run("wait 30");
    expect(s.sim.t).toBeCloseTo(t0 + 30, 0);
  });
});
