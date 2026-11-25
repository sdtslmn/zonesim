// Lab format. A lab is a YAML file: a short intro, optional setup commands
// (run quietly on the console before the learner starts, they can also play
// an attacker), tasks, automatic checks, hints and a reference solution.

import { parse } from "yaml";

export interface LabCheck {
  /** Shown to the learner, e.g. "corp-pc cannot write to plc-1". */
  name: string;
  /** Run a console command and match its output. */
  command?: string;
  outputMatches?: string;
  /** Passes only if the output does not match. */
  outputNotMatches?: string;
  exitCode?: number;
  /** Would this traffic get through? Nothing is sent. */
  flow?: { from: string; to: string; service: string; fc?: number; expect: "allowed" | "blocked" };
  /** Where a host sits. */
  zone?: { host: string; equals?: string; with?: string[]; notWith?: string[]; alone?: boolean; slAtLeast?: number };
  /** A controller point, read directly (no traffic): by signal, or by table and address. */
  register?: { host: string; signal?: string; table?: "coil" | "di" | "ir" | "hr"; addr?: number; equals?: number; gte?: number; lte?: number };
  /** A required plant data flow by id, or "all". */
  required?: string;
  /** A design check from the report by id, or "all". */
  risk?: string;
  /** A file in the learner's home folder. */
  file?: { path: string; matches?: string };
  /** An alert. */
  alert?: { title?: string; src?: string; acked?: boolean; exists?: boolean };
  /** A value in the simulation snapshot, e.g. plant.level. */
  state?: { path: string; equals?: string | number | boolean; gte?: number; lte?: number; matches?: string };
  /** A host setting. */
  host?: { name: string; mfa?: boolean };
}

export type Level = "beginner" | "intermediate" | "advanced" | "scenario";

export interface Lab {
  id: string;
  /** The site the lab was written for. It also runs on sites that extend it. */
  site: string;
  title: string;
  level: Level;
  minutes: number;
  topic: string;
  intro: string;
  setup: string[];
  /** Plant seconds to run after setup. */
  settle: number;
  tasks: string[];
  checks: LabCheck[];
  hints: string[];
  solution: string[];
  /** Shown when every check passes. */
  learned?: string;
  /** Standards and references the lab relates to. */
  refs: string[];
}

export class LabFormatError extends Error {}

const CHECK_KINDS = ["command", "flow", "zone", "register", "required", "risk", "file", "alert", "state", "host"] as const;

function str(v: unknown, field: string, id: string): string {
  if (typeof v !== "string" || !v.trim()) throw new LabFormatError(`lab ${id}: "${field}" must be a non-empty string`);
  return v;
}

function list(v: unknown, field: string, id: string, required = false): string[] {
  if (v === undefined || v === null) {
    if (required) throw new LabFormatError(`lab ${id}: "${field}" is required`);
    return [];
  }
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new LabFormatError(`lab ${id}: "${field}" must be a list of strings`);
  return v as string[];
}

export const LEVEL_ORDER: Record<Level, number> = { beginner: 0, intermediate: 1, advanced: 2, scenario: 3 };

export function parseLab(text: string, source = "lab"): Lab {
  const raw = parse(text) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") throw new LabFormatError(`${source}: not a YAML object`);
  const id = str(raw.id, "id", source);
  const level = (raw.level ?? "beginner") as Level;
  if (!(level in LEVEL_ORDER)) throw new LabFormatError(`lab ${id}: level must be beginner, intermediate, advanced or scenario`);
  const checks = raw.checks;
  if (!Array.isArray(checks) || checks.length === 0) throw new LabFormatError(`lab ${id}: "checks" must be a non-empty list`);
  for (const [i, c] of (checks as LabCheck[]).entries()) {
    if (!c || typeof c !== "object" || !c.name) throw new LabFormatError(`lab ${id}: check ${i + 1} needs a "name"`);
    const kinds = CHECK_KINDS.filter((k) => (c as unknown as Record<string, unknown>)[k] !== undefined);
    if (kinds.length !== 1) throw new LabFormatError(`lab ${id}: check "${c.name}" needs exactly one of ${CHECK_KINDS.join(", ")}`);
  }
  return {
    id,
    site: typeof raw.site === "string" ? raw.site : "riverside-water",
    title: str(raw.title, "title", id),
    level,
    minutes: typeof raw.minutes === "number" ? raw.minutes : 10,
    topic: typeof raw.topic === "string" ? raw.topic : "General",
    intro: str(raw.intro, "intro", id).trim(),
    setup: list(raw.setup, "setup", id),
    settle: typeof raw.settle === "number" ? raw.settle : 4,
    tasks: list(raw.tasks, "tasks", id, true),
    checks: checks as LabCheck[],
    hints: list(raw.hints, "hints", id),
    solution: list(raw.solution, "solution", id, true),
    learned: typeof raw.learned === "string" ? raw.learned.trim() : undefined,
    refs: list(raw.refs, "refs", id),
  };
}

/** Labs in learning order: by level, then id. */
export function sortLabs(labs: Lab[]): Lab[] {
  return [...labs].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.id.localeCompare(b.id));
}

/** Find a lab by number (1-based position), id, or id prefix like "b02". */
export function findLab(labs: Lab[], ref: string): Lab | undefined {
  const r = ref.toLowerCase();
  if (/^\d+$/.test(r)) return labs[parseInt(r, 10) - 1];
  return labs.find((l) => l.id === r) ?? labs.find((l) => l.id.startsWith(r));
}
