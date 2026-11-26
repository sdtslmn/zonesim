// Runs a lab: builds a fresh plant, plays the setup, then evaluates checks.

import { Sim } from "../sim.js";
import type { Site } from "../site.js";
import { createShell } from "../create.js";
import type { FileSystem } from "../fs.js";
import type { IO, Shell } from "../shell.js";
import type { ServiceName } from "../network.js";
import type { Lab, LabCheck } from "./schema.js";

export interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && !/^\d+$/.test(part)) {
      // zones.site -> the item whose name is "site"
      cur = cur.find((x: { name?: string; id?: string }) => x && (x.name === part || x.id === part));
      continue;
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export class LabSession {
  readonly sim: Sim;
  readonly shell: Shell;
  private hintIndex = 0;

  /** The lab must already be resolved for the site (see resolveLab). */
  constructor(
    readonly lab: Lab | undefined,
    readonly fs: FileSystem,
    opts: { site?: Site; clock?: () => number } = {},
  ) {
    this.sim = new Sim(opts);
    this.shell = createShell(this.sim, fs);
  }

  private quietIO(sink?: (t: string) => void): IO {
    return { stdout: sink ?? (() => {}), stderr: sink ?? (() => {}), sleep: async (ms) => this.sim.settle(ms / 1000) };
  }

  /** Run the setup commands quietly and let the plant settle. Returns setup errors. */
  async setup(): Promise<string[]> {
    const errors: string[] = [];
    // A few seconds of normal operation first, so the HMI has data and flows exist.
    this.sim.settle(4);
    for (const cmd of this.lab?.setup ?? []) {
      let err = "";
      const code = await this.shell.exec(cmd, { ...this.quietIO(), stderr: (t) => (err += t) });
      if (code !== 0) errors.push(`${cmd}: ${err.trim() || `exit code ${code}`}`);
      this.shell.stack.length = 0;
      this.shell.session = undefined;
    }
    this.sim.settle(this.lab?.settle ?? 0);
    return errors;
  }

  nextHint(): { text: string; index: number; total: number } | undefined {
    const hints = this.lab?.hints ?? [];
    if (!hints.length) return undefined;
    const i = Math.min(this.hintIndex, hints.length - 1);
    this.hintIndex++;
    return { text: hints[i], index: i + 1, total: hints.length };
  }

  async check(): Promise<CheckResult[]> {
    this.sim.advance();
    const out: CheckResult[] = [];
    for (const c of this.lab?.checks ?? []) out.push(await this.evaluate(c));
    return out;
  }

  private async evaluate(c: LabCheck): Promise<CheckResult> {
    const fail = (detail: string): CheckResult => ({ name: c.name, passed: false, detail });
    const pass = (): CheckResult => ({ name: c.name, passed: true });
    const sim = this.sim;
    const net = sim.net;

    if (c.command !== undefined) {
      let out = "";
      const saved = [...this.shell.stack];
      const session = this.shell.session;
      this.shell.stack.length = 0;
      this.shell.session = undefined;
      let code: number;
      try {
        code = await this.shell.exec(c.command, this.quietIO((t) => (out += t)));
      } finally {
        this.shell.stack.length = 0;
        this.shell.stack.push(...saved);
        this.shell.session = session;
      }
      const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
      if (c.exitCode !== undefined && code !== c.exitCode) return fail(`exit code ${code}`);
      if (c.outputMatches && !new RegExp(c.outputMatches, "m").test(plain)) return fail(`output was: ${plain.trim().split("\n")[0] ?? ""}`);
      if (c.outputNotMatches) {
        const m = plain.match(new RegExp(c.outputNotMatches, "m"));
        if (m) return fail(`found "${m[0]}"`);
      }
      return pass();
    }

    if (c.flow) {
      const src = net.host(c.flow.from);
      const dst = net.host(c.flow.to);
      if (!src || !dst) return fail("unknown host in check");
      const v = net.evaluate(src, dst, c.flow.service as ServiceName, c.flow.fc);
      const got = v.delivered ? "allowed" : "blocked";
      return got === c.flow.expect ? pass() : fail(got === "allowed" ? `it gets through (${v.reason})` : v.reason);
    }

    if (c.zone) {
      const h = net.host(c.zone.host);
      if (!h) return fail(`unknown host ${c.zone.host}`);
      if (c.zone.equals && h.zone !== c.zone.equals) return fail(`${h.name} is in zone ${h.zone}`);
      for (const other of c.zone.with ?? []) {
        const o = net.host(other);
        if (!o || o.zone !== h.zone) return fail(`${other} is in zone ${o?.zone ?? "?"}, ${h.name} in ${h.zone}`);
      }
      for (const other of c.zone.notWith ?? []) {
        const o = net.host(other);
        if (o && o.zone === h.zone) return fail(`${other} shares zone ${h.zone} with ${h.name}`);
      }
      if (c.zone.alone) {
        const mates = net.hostsIn(h.zone).filter((x) => x !== h);
        if (mates.length) return fail(`zone ${h.zone} also holds ${mates.map((m) => m.name).join(", ")}`);
      }
      if (c.zone.slAtLeast !== undefined) {
        const z = net.zone(h.zone);
        if (!z?.sl || z.sl < c.zone.slAtLeast) return fail(`zone ${h.zone} has SL-T ${z?.sl ?? "not set"}`);
      }
      return pass();
    }

    if (c.register) {
      const dev = sim.device(String(c.register.host));
      if (!dev) return fail(`${c.register.host} is not a Modbus device`);
      let v: number | undefined;
      let where: string;
      if (c.register.signal) {
        const at = dev.find(c.register.signal);
        v = at ? sim.plant.get(c.register.signal) : undefined;
        where = at ? `${c.register.host} ${at.table} ${at.point.addr} (${at.point.tag})` : `${c.register.host} signal ${c.register.signal}`;
      } else {
        v = dev.point(c.register.table ?? "hr", Number(c.register.addr));
        where = `${c.register.host} ${c.register.table} ${c.register.addr}`;
      }
      const shown = `${where} is ${v ?? "missing"}`;
      if (v === undefined) return fail(shown);
      if (c.register.equals !== undefined && v !== Number(c.register.equals)) return fail(shown);
      if (c.register.gte !== undefined && v < Number(c.register.gte)) return fail(shown);
      if (c.register.lte !== undefined && v > Number(c.register.lte)) return fail(shown);
      return pass();
    }

    if (c.required !== undefined) {
      const flows = sim.requiredFlows();
      const bad = flows.filter((f) => (c.required === "all" || f.flow.id === c.required) && !f.ok);
      if (c.required !== "all" && !flows.some((f) => f.flow.id === c.required)) {
        const known = sim.site.flows.find((f) => f.id === c.required);
        if (!known) return fail(`unknown flow ${c.required}`);
        return fail(known.when === "takeover" ? `${known.title} is only needed once the ${sim.site.standby?.backupName ?? "backup"} takes over` : `${known.title} is paused: a host on it is out of action`);
      }
      return bad.length ? fail(`${bad[0].flow.title}: ${bad[0].reason}${bad.length > 1 ? ` (and ${bad.length - 1} more)` : ""}`) : pass();
    }

    if (c.risk !== undefined) {
      const risks = sim.risks();
      if (c.risk !== "all" && !risks.some((r) => r.id === c.risk)) return fail(`unknown check ${c.risk}`);
      const bad = risks.filter((r) => (c.risk === "all" || r.id === c.risk) && !r.ok);
      return bad.length ? fail(`${bad[0].title}: ${bad[0].detail}`) : pass();
    }

    if (c.file) {
      const text = this.fs.readFile(c.file.path);
      if (text === undefined) return fail(`${c.file.path} does not exist`);
      if (c.file.matches && !new RegExp(c.file.matches, "im").test(text)) return fail(`${c.file.path} contains: ${text.trim().split("\n")[0] || "(empty)"}`);
      return pass();
    }

    if (c.alert) {
      const want = c.alert;
      const matches = sim.alerts.filter((a) => (!want.title || a.title.toLowerCase().includes(want.title.toLowerCase())) && (!want.src || a.src === want.src));
      if (want.exists === false) return matches.length ? fail(`found ${matches[0].id}: ${matches[0].title}`) : pass();
      if (!matches.length) return fail("no such alert");
      if (want.acked !== undefined && !matches.some((a) => a.acked === want.acked)) return fail(want.acked ? `${matches[0].id} is not acknowledged` : `${matches[0].id} is acknowledged`);
      return pass();
    }

    if (c.state) {
      const v = getPath(sim.snapshot(), c.state.path);
      const shown = `${c.state.path} is ${v === undefined ? "not set" : typeof v === "object" ? JSON.stringify(v) : String(v)}`;
      if (c.state.equals !== undefined && String(v) !== String(c.state.equals)) return fail(shown);
      if (c.state.gte !== undefined && !(Number(v) >= c.state.gte)) return fail(shown);
      if (c.state.lte !== undefined && !(Number(v) <= c.state.lte)) return fail(shown);
      if (c.state.matches && !new RegExp(c.state.matches).test(String(v ?? ""))) return fail(shown);
      return pass();
    }

    if (c.host) {
      const h = net.host(c.host.name);
      if (!h) return fail(`unknown host ${c.host.name}`);
      if (c.host.mfa !== undefined && h.mfa !== c.host.mfa) return fail(`MFA on ${h.name} is ${h.mfa ? "on" : "off"}`);
      return pass();
    }

    return fail("unknown check");
  }
}
