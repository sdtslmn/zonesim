// Labs refer to the site through placeholders, so they keep working when a
// site renames hosts, changes addresses or moves Modbus points:
//
//   ${plc}               host name of the host with role plc
//   ${plc.ip}            its IP address
//   ${plc.net}           its /24 network, e.g. 10.10.10.0/24
//   ${plc.zone}          the zone it starts in
//   ${plc.firmware}      firmware revision of its controller
//   ${plc:setpoint.stop} Modbus address of a signal on its controller
//   ${param.stopLevel}   a process parameter (arithmetic allowed: ${param.stopLevel*10-50})
//   ${tag.tank}          a process tag name
//   ${site.name}         the site name

import type { Site } from "../site.js";
import type { Lab } from "./schema.js";
import { TABLES } from "../modbus.js";

/** Evaluate + - * / and parentheses on numbers. No variables, no eval(). */
export function evalArithmetic(expr: string): number {
  let i = 0;
  const s = expr.replace(/\s+/g, "");
  const num = (): number => {
    if (s[i] === "(") {
      i++;
      const v = add();
      if (s[i++] !== ")") throw new Error("missing )");
      return v;
    }
    if (s[i] === "-") {
      i++;
      return -num();
    }
    const m = s.slice(i).match(/^\d+(\.\d+)?/);
    if (!m) throw new Error(`unexpected "${s[i] ?? "end"}"`);
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const mul = (): number => {
    let v = num();
    while (s[i] === "*" || s[i] === "/") {
      const op = s[i++];
      const r = num();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const add = (): number => {
    let v = mul();
    while (s[i] === "+" || s[i] === "-") {
      const op = s[i++];
      const r = mul();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  const v = add();
  if (i !== s.length) throw new Error(`unexpected "${s[i]}"`);
  return v;
}

export function formatNumber(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/** Resolve one placeholder body (the text between ${ and }). */
export function resolvePlaceholder(body: string, site: Site): string | number {
  const b = body.trim();
  const host = (role: string) => {
    const h = site.hosts.find((x) => x.role === role);
    if (!h) throw new Error(`the site has no host with role "${role}"`);
    return h;
  };
  if (/[*/+-]/.test(b.replace(/^[a-z0-9-]+:[a-z0-9_.]+$/, "")) && /param\./.test(b)) {
    const expr = b.replace(/param\.([A-Za-z]+)/g, (_m, name: string) => {
      const v = site.process.params[name];
      if (v === undefined) throw new Error(`unknown process parameter "${name}"`);
      return String(v);
    });
    return Math.round(evalArithmetic(expr) * 1000) / 1000;
  }
  let m = b.match(/^param\.([A-Za-z]+)$/);
  if (m) {
    const v = site.process.params[m[1]];
    if (v === undefined) throw new Error(`unknown process parameter "${m[1]}"`);
    return v;
  }
  m = b.match(/^tag\.([A-Za-z]+)$/);
  if (m) {
    const v = site.process.tags[m[1]];
    if (v === undefined) throw new Error(`unknown process tag "${m[1]}"`);
    return v;
  }
  if (b === "site.name") return site.name;
  if (b === "site.id") return site.id;
  m = b.match(/^([a-z][a-z0-9-]*):([a-z0-9_.]+)$/);
  if (m) {
    const h = host(m[1]);
    const dev = site.devices[h.name];
    if (!dev) throw new Error(`${h.name} (role ${m[1]}) is not a Modbus device`);
    for (const t of TABLES) {
      const p = dev.points[t].find((x) => x.signal === m![2]);
      if (p) return p.addr;
    }
    throw new Error(`signal ${m[2]} is not mapped on ${h.name}`);
  }
  m = b.match(/^([a-z][a-z0-9-]*)(?:\.(ip|net|zone|firmware|product|user))?$/);
  if (m) {
    const h = host(m[1]);
    switch (m[2]) {
      case undefined:
        return h.name;
      case "ip":
        return h.ip;
      case "net":
        return `${h.ip.split(".").slice(0, 3).join(".")}.0/24`;
      case "zone": {
        const z = site.zones.find((x) => x.hosts.includes(h.name));
        if (!z) throw new Error(`${h.name} is in no zone`);
        return z.name;
      }
      case "firmware":
      case "product": {
        const dev = site.devices[h.name];
        if (!dev) throw new Error(`${h.name} (role ${m[1]}) is not a Modbus device`);
        return m[2] === "firmware" ? dev.revision : dev.product;
      }
      case "user":
        return h.user;
    }
  }
  throw new Error(`unknown placeholder \${${body}}`);
}

/** Replace placeholders in a string. A string that is only one numeric placeholder becomes a number. */
export function substitute(text: string, site: Site): string | number {
  const whole = text.match(/^\$\{([^}]+)\}$/);
  if (whole) {
    const v = resolvePlaceholder(whole[1], site);
    return v;
  }
  return text.replace(/\$\{([^}]+)\}/g, (_m, body: string) => {
    const v = resolvePlaceholder(body, site);
    return typeof v === "number" ? formatNumber(v) : v;
  });
}

function deep(value: unknown, site: Site): unknown {
  if (typeof value === "string") return substitute(value, site);
  if (Array.isArray(value)) return value.map((v) => deep(v, site));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deep(v, site)]));
  return value;
}

/** A copy of the lab with every placeholder filled in for this site. */
export function resolveLab(lab: Lab, site: Site): { lab?: Lab; error?: string } {
  try {
    const text = (s: string) => {
      const v = substitute(s, site);
      return typeof v === "number" ? formatNumber(v) : v;
    };
    return {
      lab: {
        ...lab,
        intro: text(lab.intro),
        setup: lab.setup.map(text),
        tasks: lab.tasks.map(text),
        hints: lab.hints.map(text),
        solution: lab.solution.map(text),
        learned: lab.learned === undefined ? undefined : text(lab.learned),
        checks: deep(lab.checks, site) as Lab["checks"],
      },
    };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
