import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseLab, LabSession, MemoryFS, type IO, type Lab } from "../src/index.js";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : n.endsWith(".yaml") ? [p] : [];
  });
}

const labs: Lab[] = files(join(__dirname, "../../../labs")).map((f) => parseLab(readFileSync(f, "utf8"), f));

describe("labs", () => {
  it("have unique ids", () => {
    const ids = labs.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(12);
  });

  for (const lab of labs) {
    it(`${lab.id} is not solved at the start and is solved by its solution`, async () => {
      const s = new LabSession(lab, new MemoryFS(), { clock: () => 0 });
      expect(await s.setup()).toEqual([]);
      const before = await s.check();
      expect(before.every((r) => r.passed)).toBe(false);
      for (const line of lab.solution) {
        let err = "";
        const io: IO = { stdout: () => {}, stderr: (t) => (err += t), sleep: async (ms) => s.sim.settle(ms / 1000) };
        const code = await s.shell.exec(line, io);
        if (!line.includes("#")) expect(code, `${line}: ${err}`).toBe(0);
      }
      s.sim.settle(2);
      const after = await s.check();
      expect(after.filter((r) => !r.passed)).toEqual([]);
    });
  }
});
