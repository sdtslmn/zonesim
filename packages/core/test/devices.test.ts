import { describe, expect, it } from "vitest";
import { sandbox } from "./helpers.js";
import { Sim, MemoryFS, createShell, builtinSite, Trainer, type IO } from "../src/index.js";
import { matchPattern, type Pattern } from "../src/devices/session.js";

function gasSandbox() {
  const sim = new Sim({ clock: () => 0, site: builtinSite("gas-compressor-station") });
  const fs = new MemoryFS();
  const shell = createShell(sim, fs);
  sim.settle(4);
  const run = async (cmd: string) => {
    let out = "";
    let err = "";
    const io: IO = { stdout: (t) => (out += t), stderr: (t) => (err += t), sleep: async (ms) => sim.settle(ms / 1000) };
    const code = await shell.exec(cmd, io);
    const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    return { code, out: plain(out), err: plain(err) };
  };
  return { sim, shell, run };
}

describe("command matching", () => {
  type M = "a";
  const hits: string[] = [];
  const P: Pattern<M>[] = [
    { modes: ["a"], words: ["show", "vlan", "brief"], run: () => hits.push("svb") },
    { modes: ["a"], words: ["show", "version"], run: () => hits.push("sv") },
    { modes: ["a"], words: ["name", "<id>", "<name...>"], run: () => hits.push("name") },
  ];
  it("accepts unique prefixes and rejects ambiguous ones", () => {
    const m = matchPattern(P, "a", ["sh", "vl", "br"]);
    expect("pattern" in m && m.pattern.words.join(" ")).toBe("show vlan brief");
    expect(matchPattern(P, "a", ["sh", "v"])).toEqual({ error: "ambiguous:v" });
    expect(matchPattern(P, "a", ["show"])).toEqual({ error: "incomplete" });
    const n = matchPattern(P, "a", ["name", "20", "control", "room"]);
    expect("args" in n && n.args).toEqual(["20", "control room"]);
  });
});

describe("network devices", () => {
  it("lists the firewall and switches", async () => {
    const s = sandbox();
    const r = await s.run("devices");
    expect(r.out).toContain("fw-01");
    expect(r.out).toContain("Hirschmann RSP35");
    expect(r.out).toContain("FortiOS");
  });

  it("HiOS: a VLAN and a PVID move a host to a new zone", async () => {
    const s = sandbox();
    await s.run("ssh sw-01");
    expect(s.shell.prompt()).toBe("(Hirschmann SW-RIVERSIDE-01) > ");
    expect((await s.run("vlan database")).err).toContain("Invalid command");
    for (const c of ["enable", "vlan database", "vlan add 20", "name 20 control", "exit", "configure", "interface 1/7"]) await s.run(c);
    expect(s.shell.prompt()).toBe("(Hirschmann SW-RIVERSIDE-01) (Interface 1/7)# ");
    await s.run("vlan participation include 20");
    await s.run("vlan pvid 20");
    expect(s.sim.net.host("plc-1")?.zone).toBe("control");
    expect(s.sim.net.host("plc-1")?.link).toBe(true);
    expect((await s.run("do show vlan brief")).err).toContain("Invalid");
    await s.run("exit");
    await s.run("exit");
    expect((await s.run("sh vl br | include control")).out.trim()).toBe("20 control                          static");
    await s.run("exit");
    await s.run("exit");
    expect(s.shell.session).toBeUndefined();
    expect((await s.run("test hmi-01 plc-1 modbus")).out).toContain("no conduit between zones site and control");
  });

  it("HiOS: a port outside its own VLAN, or shut down, cuts the host off", async () => {
    const s = sandbox();
    await s.run("ssh sw-01 'enable; vlan database; vlan add 30; exit; configure; interface 1/5; vlan pvid 30'");
    // PVID 30 without membership: plc traffic from the HMI cannot flow.
    const h = s.sim.net.host("hmi-01")!;
    expect(h.zone).toBe("vlan30");
    expect(h.link).toBe(false);
    expect((await s.run("test hmi-01 plc-1 modbus")).out).toContain("not a member of VLAN 30");
    await s.run("ssh sw-01 'enable; configure; interface 1/5; vlan participation include 30'");
    expect(h.link).toBe(true);
    await s.run("ssh sw-01 'enable; configure; interface 1/8; shutdown'");
    expect((await s.run("test hmi-01 sis-1 modbus")).out).toContain("sis-1 is cut off");
  });

  it("Cisco IOS: access VLANs, shutdown and errors", async () => {
    const s = gasSandbox();
    await s.run("ssh sw-office");
    expect(s.shell.prompt()).toBe("SW-KESTREL-OFFICE>");
    const bad = await s.run("configure terminal");
    expect(bad.err).toContain("% Invalid input detected at '^' marker.");
    for (const c of ["en", "conf t", "vlan 40", "name enterprise", "exit", "int gi1/1", "switchport mode access", "switchport access vlan 40"]) await s.run(c);
    expect(s.shell.prompt()).toBe("SW-KESTREL-OFFICE(config-if)#");
    expect(s.sim.net.host("corp-pc")?.zone).toBe("enterprise");
    await s.run("shutdown");
    expect((await s.run("do show interfaces status | include Gi1/1")).out).toContain("disabled");
    await s.run("end");
    expect((await s.run("write memory")).out).toContain("[OK]");
    expect((await s.run("show running-config | include access vlan 40")).out.trim()).toBe("switchport access vlan 40");
  });

  it("FortiOS: policies are firewall rules, and application control filters Modbus", async () => {
    const s = sandbox();
    // Put plc-1 behind its own interface first.
    await s.run("ssh sw-01 'enable; vlan database; vlan add 20; name 20 control; exit; configure; interface 1/7; vlan participation include 20; vlan pvid 20'");
    await s.run("ssh fw-01");
    expect(s.shell.prompt()).toBe("FGR60F-RIVERSIDE # ");
    for (const c of ["config firewall policy", "edit 0"]) await s.run(c);
    expect((await s.run("set srcintf nowhere")).err).toContain("entry not found in datasource");
    for (const c of ["set name hmi-plc", "set srcintf site", "set dstintf control", "set srcaddr hmi-01", "set dstaddr plc-1", "set service MODBUS", "set action accept", "next", "end"]) await s.run(c);
    expect(s.sim.net.evaluate(s.sim.net.host("hmi-01")!, s.sim.net.host("plc-1")!, "modbus", 6).allowed).toBe(true);
    for (const c of [
      "config application list",
      "edit read-only",
      "config entries",
      "edit 1",
      "set application Modbus_Read.Holding.Registers Modbus_Read.Input.Registers",
      "set action pass",
      "next",
      "edit 2",
      "set application Modbus",
      "set action block",
      "next",
      "end",
      "next",
      "end",
    ])
      await s.run(c);
    const id = s.sim.infra.policies().find((p) => p.name === "hmi-plc")!.id;
    for (const c of ["config firewall policy", `edit ${id}`, "set utm-status enable", "set application-list read-only", "end"]) await s.run(c);
    const hmi = s.sim.net.host("hmi-01")!;
    const plc = s.sim.net.host("plc-1")!;
    expect(s.sim.net.evaluate(hmi, plc, "modbus", 3).allowed).toBe(true);
    expect(s.sim.net.evaluate(hmi, plc, "modbus", 6).allowed).toBe(false);
    expect((await s.run(`show firewall policy ${id}`)).out).toContain('set application-list "read-only"');
    // Without the OT signatures the firewall cannot see function codes.
    for (const c of ["config ips global", "set exclude-signatures industrial", "end"]) await s.run(c);
    expect(s.sim.net.evaluate(hmi, plc, "modbus", 6).allowed).toBe(true);
    expect((await s.run("get system status")).out).toContain("OT signatures excluded");
    for (const c of ["config ips global", "set exclude-signatures none", "end"]) await s.run(c);
    expect(s.sim.net.evaluate(hmi, plc, "modbus", 6).allowed).toBe(false);
    await s.run("exit");
    // The console shows the same rule.
    expect((await s.run("fw list site-control")).out).toMatch(/allow\s+hmi-01 → plc-1\s+modbus fc 3,4/);
  });

  it("FortiOS: the traffic log and policy hits", async () => {
    const s = sandbox();
    await s.run("zone create control");
    await s.run("zone add control plc-1");
    await s.run("conduit create site-control site control");
    await s.run("fw allow site-control from hmi-01 to plc-1 modbus fc 3,4");
    s.sim.settle(6);
    const log = await s.run("ssh fw-01 execute log display");
    expect(log.out).toMatch(/srcip=10\.10\.20\.10 srcintf="site" dstip=10\.10\.10\.10 dstintf="control" service="MODBUS" policyid=\d+ action="accept" app="Modbus_Read\.Holding\.Registers"/);
    expect((await s.run("ssh fw-01 diagnose firewall policy hits")).out).toMatch(/site -> control\s+hits [1-9]/);
    // Console fc rules use an application control list.
    expect((await s.run("ssh fw-01 show application list modbus-fc-3-4")).out).toContain("set application Modbus_Read.Holding.Registers Modbus_Read.Input.Registers");
  });

  it("completes device commands", async () => {
    const t = new Trainer({ labs: [], clock: () => 0, print: () => {} });
    await t.startSandbox(false);
    expect(t.complete("ssh f")).toContain("fw-01");
    await t.shell.exec("ssh fw-01", { stdout: () => {}, stderr: () => {}, sleep: async () => {} });
    expect(t.complete("con")).toEqual(["config"]);
    expect(t.complete("config fire")).toEqual(["firewall"]);
    await t.shell.exec("config firewall policy\nedit 0", { stdout: () => {}, stderr: () => {}, sleep: async () => {} });
    expect(t.complete("set src").sort()).toEqual(["srcaddr", "srcintf"]);
    expect(t.complete("set service MOD")).toEqual(["MODBUS"]);
  });
});

describe("switch brands in site files", () => {
  it("changes a switch brand in an extending site", async () => {
    const { loadSiteFile } = await import("../src/index.js");
    const r = loadSiteFile(`schema: zonesim-site/1\nid: cisco-riverside\nname: Riverside with Cisco\nextends: riverside-water\nnetwork:\n  switches:\n    - { name: sw-01, vendor: cisco }\n`);
    expect(r.errors).toEqual([]);
    const sw = r.site!.network.switches[0];
    expect(sw.vendor).toBe("cisco");
    expect(sw.model).toBe("IE-3400");
    expect(sw.ports[0]).toEqual({ id: "Gi1/1", host: "corp-pc" });
  });
});
