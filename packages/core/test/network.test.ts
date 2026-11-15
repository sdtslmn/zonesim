import { describe, expect, it } from "vitest";
import { Network } from "../src/network.js";

const h = (n: Network, name: string) => n.needHost(name);

describe("zones and conduits", () => {
  it("starts flat: everything inside the site talks", () => {
    const n = new Network();
    expect(n.evaluate(h(n, "corp-pc"), h(n, "plc-1"), "modbus", 6).delivered).toBe(true);
    expect(n.evaluate(h(n, "vendor-laptop"), h(n, "ews-01"), "rdp").delivered).toBe(true);
    expect(n.evaluate(h(n, "vendor-laptop"), h(n, "plc-1"), "modbus").allowed).toBe(false);
  });

  it("blocks traffic between zones without a conduit", () => {
    const n = new Network();
    n.createZone("office");
    n.addToZone("office", ["corp-pc"]);
    const v = n.evaluate(h(n, "corp-pc"), h(n, "plc-1"), "modbus", 3);
    expect(v.allowed).toBe(false);
    expect(v.blockedBy).toBe("no-conduit");
  });

  it("applies rules top-down, one-way, with default deny", () => {
    const n = new Network();
    n.createZone("ops");
    n.addToZone("ops", ["historian"]);
    n.createConduit("ops-site", "ops", "site");
    n.addRule("ops-site", { action: "deny", src: n.parseEndpoint("historian"), dst: n.parseEndpoint("sis-1"), service: "modbus" });
    n.addRule("ops-site", { action: "allow", src: n.parseEndpoint("historian"), dst: n.parseEndpoint("site"), service: "modbus" });
    expect(n.evaluate(h(n, "historian"), h(n, "plc-1"), "modbus", 3).delivered).toBe(true);
    expect(n.evaluate(h(n, "historian"), h(n, "sis-1"), "modbus", 3).blockedBy).toBe("deny-rule");
    expect(n.evaluate(h(n, "plc-1"), h(n, "historian"), "https").blockedBy).toBe("default-deny");
    expect(n.evaluate(h(n, "historian"), h(n, "plc-1"), "https").allowed).toBe(false);
  });

  it("filters Modbus function codes", () => {
    const n = new Network();
    n.createZone("ops");
    n.addToZone("ops", ["historian"]);
    n.createConduit("c", "ops", "site");
    n.addRule("c", { action: "allow", src: n.parseEndpoint("historian"), dst: n.parseEndpoint("plc-1"), service: "modbus", fc: n.parseFunctionCodes("3,4") });
    expect(n.evaluate(h(n, "historian"), h(n, "plc-1"), "modbus", 4).delivered).toBe(true);
    const v = n.evaluate(h(n, "historian"), h(n, "plc-1"), "modbus", 6);
    expect(v.blockedBy).toBe("function-code");
    // A port scan only opens the connection, so it sees the port as open.
    expect(n.evaluate(h(n, "historian"), h(n, "plc-1"), "modbus").delivered).toBe(true);
    expect(n.parseFunctionCodes("read")).toEqual([1, 2, 3, 4, 43]);
  });

  it("reports nothing listening as allowed but not delivered", () => {
    const n = new Network();
    const v = n.evaluate(h(n, "corp-pc"), h(n, "plc-1"), "rdp");
    expect(v.allowed).toBe(true);
    expect(v.delivered).toBe(false);
  });

  it("validates names and structure", () => {
    const n = new Network();
    expect(() => n.createZone("plc-1")).toThrow(/host name/);
    expect(() => n.createZone("Bad Name")).toThrow();
    expect(() => n.deleteZone("site")).toThrow(/still holds/);
    n.createZone("a");
    expect(() => n.createConduit("x", "a", "a")).toThrow(/two different zones/);
    n.createConduit("x", "a", "site");
    expect(() => n.createConduit("y", "site", "a")).toThrow(/already connected/);
    expect(() => n.addRule("x", { action: "allow", src: { type: "any" }, dst: { type: "any" }, service: "https", fc: [3] })).toThrow(/only apply to the modbus/);
  });
});
