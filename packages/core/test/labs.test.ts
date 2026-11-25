import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseLab, builtinSite, loadSiteFile, resolveLab, validateLabOnSite, substitute, evalArithmetic, type Lab } from "../src/index.js";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : n.endsWith(".yaml") ? [p] : [];
  });
}

const root = join(__dirname, "../../..");
const labs: Lab[] = files(join(root, "labs")).map((f) => parseLab(readFileSync(f, "utf8"), f));
const riverside = builtinSite();
const templateResult = loadSiteFile(readFileSync(join(root, "sites/templates/my-site.yaml"), "utf8"));

describe("labs", () => {
  it("have unique ids", () => {
    const ids = labs.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(12);
  });

  it("use placeholders instead of host names and addresses", () => {
    for (const lab of labs) {
      const text = JSON.stringify([lab.intro, lab.tasks, lab.hints, lab.solution, lab.setup, lab.checks]);
      expect(text, lab.id).not.toMatch(/\bplc-1\b|\bsis-1\b|\bhmi-01\b|\bucp-1\b|\besd-1\b|\bfc-1\b|\bcpc-1\b|\bfp-1\b|\bbms-01\b|10\.10\.|172\.16\.|10\.50\./);
    }
  });

  it("cover every built-in plant", () => {
    for (const id of ["riverside-water", "gas-compressor-station", "data-centre-cooling"]) expect(labs.filter((l) => l.site === id).length, id).toBeGreaterThanOrEqual(10);
  });

  for (const lab of labs) {
    it(`${lab.id} works on its own site`, async () => {
      const fit = await validateLabOnSite(lab, builtinSite(lab.site));
      expect(fit.problems).toEqual([]);
    });
  }

  it("the template site loads", () => {
    expect(templateResult.errors).toEqual([]);
    expect(templateResult.site?.hosts.find((h) => h.role === "plc")?.name).toBe("tank-plc");
  });

  for (const lab of labs.filter((l) => l.site === riverside.id)) {
    it(`${lab.id} works on the template site`, async () => {
      const fit = await validateLabOnSite(lab, templateResult.site!);
      expect(fit.problems).toEqual([]);
    });
  }
});

describe("placeholders", () => {
  const site = templateResult.site!;

  it("resolve hosts, addresses, signals and parameters", () => {
    expect(substitute("ssh ${hmi} modbus read ${plc} hr ${plc:setpoint.stop}", site)).toBe("ssh scada-hmi modbus read tank-plc hr 101");
    expect(substitute("${plc.ip} ${plc.net} ${plc.firmware}", site)).toBe("192.168.10.10 192.168.10.0/24 3.1.0");
    expect(substitute("${param.stopLevel*10-50}", site)).toBe(700);
    expect(substitute("${param.inflow-param.demand} %", site)).toBe("1 %");
    expect(substitute("${plc.zone}", site)).toBe("site");
  });

  it("report what is missing", () => {
    expect(() => substitute("${pump}", site)).toThrow(/no host with role "pump"/);
    expect(() => substitute("${plc:valve.open}", site)).toThrow(/not mapped/);
    expect(() => substitute("${param.nope}", site)).toThrow(/unknown process parameter/);
  });

  it("arithmetic is safe and correct", () => {
    expect(evalArithmetic("2*(3+4)-1")).toBe(13);
    expect(evalArithmetic("-5+10/4")).toBe(-2.5);
    expect(() => evalArithmetic("alert(1)")).toThrow();
  });

  it("a lab that needs a missing role does not resolve", () => {
    const broken = { ...labs.find((l) => l.site === "riverside-water")!, tasks: ["ssh ${pump}"] };
    expect(resolveLab(broken, site).error).toMatch(/pump/);
  });
});
