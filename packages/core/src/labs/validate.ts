// Checks that a lab works on a site: its placeholders resolve, it is not
// already solved at the start, and its own solution solves it.

import { LabSession } from "./session.js";
import { resolveLab } from "./resolve.js";
import { MemoryFS } from "../fs.js";
import { siteCompatible, type Site } from "../site.js";
import type { IO } from "../shell.js";
import type { Lab } from "./schema.js";

export interface LabFit {
  lab: Lab;
  ok: boolean;
  problems: string[];
  checks: number;
}

export async function validateLabOnSite(lab: Lab, site: Site): Promise<LabFit> {
  const problems: string[] = [];
  if (!siteCompatible(site, lab.site)) return { lab, ok: false, problems: [`written for site ${lab.site}, and ${site.id} does not extend it`], checks: 0 };
  const r = resolveLab(lab, site);
  if (!r.lab) return { lab, ok: false, problems: [r.error ?? "placeholders do not resolve"], checks: 0 };
  const resolved = r.lab;
  const s = new LabSession(resolved, new MemoryFS(), { site, clock: () => 0 });
  problems.push(...(await s.setup()).map((e) => `setup: ${e}`));
  const before = await s.check();
  if (before.every((x) => x.passed)) problems.push("every check already passes before the solution");
  for (const line of resolved.solution) {
    let err = "";
    const io: IO = { stdout: () => {}, stderr: (t) => (err += t), sleep: async (ms) => s.sim.settle(ms / 1000) };
    const code = await s.shell.exec(line, io);
    // A step with a comment may fail on purpose ("# times out, as it should").
    if (code !== 0 && !line.includes("#")) problems.push(`solution step failed: ${line}: ${err.trim()}`);
  }
  s.sim.settle(2);
  const after = await s.check();
  for (const x of after.filter((c) => !c.passed)) problems.push(`check fails after the solution: ${x.name} (${x.detail ?? ""})`);
  return { lab, ok: problems.length === 0, problems, checks: after.length };
}

export async function validateLabsOnSite(labs: Lab[], site: Site): Promise<LabFit[]> {
  const out: LabFit[] = [];
  for (const lab of labs) out.push(await validateLabOnSite(lab, site));
  return out;
}
