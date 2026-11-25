import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { builtinSite, builtinSiteIds, loadSiteFile, Sim, BUILTIN_SITE_FILES } from "../src/index.js";

const root = join(__dirname, "../../..");
const load = (yaml: string) => loadSiteFile(yaml);
const extend = (body: string) => load(`schema: zonesim-site/1\nid: test-site\nname: Test\nextends: riverside-water\n${body}`);

describe("built-in sites", () => {
  it("all load without errors", () => {
    expect(builtinSiteIds()).toContain("riverside-water");
    for (const id of builtinSiteIds()) expect(builtinSite(id).hosts.length).toBeGreaterThan(0);
  });

  it("the embedded copy matches the files in sites/", () => {
    const before = readFileSync(join(root, "packages/core/src/sites/builtin.generated.ts"), "utf8");
    execFileSync("node", [join(root, "scripts/embed-sites.mjs")], { cwd: root });
    const after = readFileSync(join(root, "packages/core/src/sites/builtin.generated.ts"), "utf8");
    expect(after).toBe(before);
    const files = readdirSync(join(root, "sites")).filter((f) => f.endsWith(".yaml"));
    expect(Object.keys(BUILTIN_SITE_FILES).sort()).toEqual(files.map((f) => f.replace(/\.yaml$/, "")).sort());
  });
});

describe("site files", () => {
  it("extend a built-in site and change only what they name", () => {
    const r = extend(`hosts:\n  - { name: plc-1, ip: 172.16.1.10 }\nprocess:\n  params: { stopLevel: 70 }\n`);
    expect(r.errors).toEqual([]);
    const s = r.site!;
    expect(s.hosts.find((h) => h.name === "plc-1")?.ip).toBe("172.16.1.10");
    expect(s.hosts.find((h) => h.name === "plc-1")?.role).toBe("plc");
    expect(s.process.params.stopLevel).toBe(70);
    expect(s.process.params.startLevel).toBe(40);
    expect(s.extends).toContain("riverside-water");
  });

  it("rename hosts everywhere they are used", () => {
    const s = extend(`rename: { plc-1: tank-plc, site: plant }\n`).site!;
    expect(s.hosts.some((h) => h.name === "plc-1")).toBe(false);
    expect(s.devices["tank-plc"]).toBeDefined();
    expect(s.hmi?.device).toBe("tank-plc");
    expect(s.zones.find((z) => z.name === "plant")?.hosts).toContain("tank-plc");
    expect(s.flows.find((f) => f.id === "hmi-plc")?.paths[0][0].to).toBe("tank-plc");
    expect(s.ids.writers["tank-plc"]).toContain("hmi-01");
    expect(s.polling.some((p) => p.to === "tank-plc")).toBe(true);
  });

  it("add and remove hosts", () => {
    const r = extend(
      `hosts:\n  - { name: plc-2, role: plc2, ip: 10.10.10.11, level: 1, kind: ot, services: [modbus], os: PLC, description: Second PLC }\n  - { name: jump-01, remove: true }\n` +
        `zones:\n  - { name: site, hosts: [corp-pc, hist-dmz, historian, hmi-01, ews-01, plc-1, plc-2, sis-1] }\n` +
        `flows:\n  - { id: vendor-support, remove: true }\n`,
    );
    expect(r.errors).toEqual([]);
    expect(r.site!.hosts.map((h) => h.name)).toContain("plc-2");
    expect(r.site!.hosts.map((h) => h.name)).not.toContain("jump-01");
  });

  it("explain mistakes in plain words", () => {
    const errs = (body: string) => extend(body).errors.join("\n");
    expect(errs(`hosts:\n  - { name: plc-1, ip: 300.1.1.1 }\n`)).toMatch(/not an IPv4 address/);
    expect(errs(`hosts:\n  - { name: hmi-01, ip: 10.10.10.10 }\n`)).toMatch(/used twice/);
    expect(errs(`process:\n  params: { stopLevel: 30 }\n`)).toMatch(/stop/i);
    expect(errs(`process:\n  params: { speed: 3 }\n`)).toMatch(/not a parameter/);
    expect(errs(`rename: { plc-9: x }\n`)).toMatch(/not a host or zone/);
    expect(errs(`devices:\n  plc-1:\n    points:\n      coil:\n        - { addr: 0, tag: X, signal: level, description: wrong table }\n`)).toMatch(/belongs in ir/);
    expect(load(`schema: zonesim-site/1\nid: x\nname: X\nextends: nowhere\n`).errors.join()).toMatch(/no built-in site "nowhere"/);
    expect(load(`: : :`).errors.length).toBeGreaterThan(0);
  });

  it("reject firewall rules that do not parse", () => {
    const r = extend(`conduits:\n  - { name: edge, zones: [internet, site], rules: ["allow from vendor-laptop to ews-01 telnet"] }\n`);
    expect(r.errors.join("\n")).toMatch(/telnet/);
  });

  it("run in the simulator with their own names, addresses and settings", () => {
    const site = loadSiteFile(readFileSync(join(root, "sites/templates/my-site.yaml"), "utf8")).site!;
    const sim = new Sim({ site, clock: () => 0 });
    sim.settle(4);
    expect(sim.net.needHost("tank-plc").ip).toBe("192.168.10.10");
    expect(sim.device("tank-plc")?.point("hr", 101)).toBe(750);
    expect(sim.hmiOnline).toBe(true);
    expect(sim.requiredFlows().every((f) => f.ok)).toBe(true);
  });
});

describe("site file help", () => {
  it("warns about field names it does not know", () => {
    const r = extend(`hosts:\n  - { name: plc-1, adress: 10.0.0.1 }\n`);
    expect(r.warnings.join("\n")).toMatch(/unknown field "adress".*Did you mean "address"|unknown field "adress"/);
  });

  it("the published JSON Schema is current", async () => {
    const { siteJsonSchema } = await import("../src/site-schema.js");
    const file = JSON.parse(readFileSync(join(root, "schema/site.schema.json"), "utf8"));
    expect(file).toEqual(siteJsonSchema());
  });
});
