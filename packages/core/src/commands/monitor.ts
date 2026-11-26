// Monitoring commands: the OT monitoring sensor (mode, links, baseline) and
// the asset inventory it builds from the traffic it sees.

import type { CommandFn } from "../shell.js";
import type { Sim } from "../sim.js";
import { linkText } from "../sensor.js";
import { C, UserError, table, ago, clock } from "../util.js";

const wantsHelp = (args: string[]) => args.includes("--help") || args.includes("-h");

const IDS_HELP = `ids                           the sensor: mode, baseline, assets and open alerts
ids mode learning|protecting  learn everything it sees, or alert on anything new
ids links [HOST] [--new]      links the sensor has seen, and whether each is in the baseline
ids baseline [HOST]           the links and function codes the sensor treats as normal
ids baseline delete N         forget a learned link, so it alerts again
ids learn ALERT               accept what an anomaly alert saw as normal
`;

function hostFilter(sim: Sim, arg: string | undefined): string | undefined {
  if (!arg) return undefined;
  return sim.net.needHost(arg).name;
}

function sensorPlace(sim: Sim): string {
  const sw = sim.infra.switches[0];
  return sw ? `on a mirror port of ${sw.name}` : "on a mirror port";
}

export const idsCmd: CommandFn = (args, { io, sim }) => {
  const [sub, ...rest] = args;
  const s = sim.sensor;
  if (wantsHelp(args)) {
    io.stdout(IDS_HELP);
    return 0;
  }
  if (!sub || sub === "status") {
    const open = sim.alerts.filter((a) => !a.acked);
    const by = (sev: string) => open.filter((a) => a.severity === sev).length;
    const newLinks = s.links().filter((l) => !l.learned || l.newFcs.length).length;
    io.stdout(
      `${C.bold("IDS sensor")} ${sensorPlace(sim)}\n` +
        `  Mode:      ${s.mode === "protecting" ? C.green("protecting") + "  (alerts on anything outside the baseline)" : C.yellow("learning") + "  (adds everything it sees to the baseline, no anomaly alerts)"}\n` +
        `  Baseline:  ${s.baseline.length} links\n` +
        `  Seen:      ${s.seen.size} links, ${newLinks ? C.red(`${newLinks} outside the baseline`) : "all in the baseline"}\n` +
        `  Assets:    ${s.assets(sim.net.hosts).length}\n` +
        `  Alerts:    ${open.length} open (${by("critical")} critical, ${by("high")} high, ${by("medium")} medium, ${by("low")} low)\n` +
        C.gray("ids links, ids baseline, assets, alerts\n"),
    );
    return 0;
  }
  if (sub === "mode") {
    const m = rest[0];
    if (m !== "learning" && m !== "protecting") throw new UserError("usage: ids mode learning|protecting");
    if (s.mode === m) {
      io.stdout(`The sensor is already ${m}.\n`);
      return 0;
    }
    s.mode = m;
    io.stdout(m === "learning" ? `The sensor is learning: whatever it sees now becomes normal, and it raises no anomaly alerts.\n${C.yellow("Switch back with ids mode protecting once the plant runs as it should.")}\n` : `The sensor is protecting: anything outside the baseline (${s.baseline.length} links) raises an alert.\n`);
    sim.emit();
    return 0;
  }
  if (sub === "links") {
    const onlyNew = rest.includes("--new");
    const host = hostFilter(sim, rest.find((a) => !a.startsWith("-")));
    let list = s.links().sort((a, b) => b.lastT - a.lastT);
    if (host) list = list.filter((l) => l.src === host || l.dst === host);
    if (onlyNew) list = list.filter((l) => !l.learned || l.newFcs.length);
    if (!list.length) {
      io.stdout(onlyNew ? "Every link the sensor has seen is in the baseline.\n" : "The sensor has seen no matching traffic yet.\n");
      return 0;
    }
    const rows = list.map((l) => [l.src, l.dst, l.service, l.fcs.length ? l.fcs.join(",") : "-", String(l.packets), ago(sim.t - l.lastT), !l.learned ? C.red("new link") : l.newFcs.length ? C.red(`new fc ${l.newFcs.join(",")}`) : C.green("baseline")]);
    io.stdout(table(["FROM", "TO", "SERVICE", "FC", "PACKETS", "LAST", "STATUS"], rows));
    return 0;
  }
  if (sub === "baseline") {
    if (rest[0] === "delete") {
      const n = Number(rest[1]);
      if (!rest[1] || !Number.isInteger(n)) throw new UserError("usage: ids baseline delete N");
      const b = s.forget(n);
      if (!b) throw new UserError(`no baseline link ${rest[1]} (see ids baseline)`);
      io.stdout(`forgot ${b.src} → ${b.dst} ${b.service}. It raises a New link alert the next time it is seen.\n`);
      sim.emit();
      return 0;
    }
    const host = hostFilter(sim, rest[0]);
    const list = s.baseline.filter((b) => !host || b.src === host || b.dst === host);
    if (!list.length) {
      io.stdout("The baseline is empty.\n");
      return 0;
    }
    const how = (b: (typeof list)[number]) => (b.how === "commissioning" ? "commissioning" : `${b.how === "alert" ? "from an alert" : "learning"} at ${clock(b.t ?? 0)}`);
    const rows = list.map((b) => [String(b.id), b.src, b.dst, b.service, b.service === "modbus" ? (b.anyFc ? "any" : b.fcs.join(",") || "none") : "-", b.how === "commissioning" ? C.gray(how(b)) : C.yellow(how(b))]);
    io.stdout(table(["N", "FROM", "TO", "SERVICE", "FC", "LEARNED"], rows));
    io.stdout(C.gray("ids baseline delete N forgets a link\n"));
    return 0;
  }
  if (sub === "learn") {
    if (!rest[0]) throw new UserError("usage: ids learn ALERT");
    const a = sim.learnAlert(rest[0]);
    io.stdout(`learned ${a.anomaly!.map(linkText).join("; ")}\n${a.id} is closed. The sensor treats this as normal from now on.\n`);
    return 0;
  }
  throw new UserError(`unknown ids command: ${sub}\n${IDS_HELP}`);
};

export const assetsCmd: CommandFn = (args, { io, sim }) => {
  if (wantsHelp(args)) {
    io.stdout("assets         the asset inventory the IDS sensor built from the traffic it sees\nassets HOST    one asset: identity, services, peers and alerts\n");
    return 0;
  }
  const list = sim.sensor.assets(sim.net.hosts);
  const name = args.find((a) => !a.startsWith("-"));
  if (name) {
    const h = sim.net.needHost(name);
    const a = list.find((x) => x.name === h.name);
    if (!a) {
      io.stdout(`The sensor has not seen ${h.name} on the network.\n`);
      return 0;
    }
    const id = a.identity;
    const alerts = sim.alerts.filter((x) => !x.acked && (x.src === a.name || x.dst === a.name));
    io.stdout(
      `${C.bold(a.name)}  ${a.type}${a.known ? "" : C.red("  (new: not in the baseline)")}\n` +
        `  IP:        ${a.ip}   zone ${a.zone}\n` +
        (id ? `  Identity:  ${id.vendor} ${id.product}, firmware ${id.revision}\n             ${C.gray(id.t === undefined ? "seen while the sensor was commissioned" : `seen on the wire at ${clock(id.t)} (device identification, fc 43)`)}\n` : sim.devices.has(a.name) ? `  Identity:  ${C.gray("not seen yet. The sensor learns it when someone reads device identification (fc 43).")}\n` : "") +
        (a.os ? `  OS:        ${a.os}\n` : "") +
        `  Serves:    ${a.serves.join(", ") || "-"}\n  Uses:      ${a.uses.join(", ") || "-"}\n  Peers:     ${a.peers.join(", ") || "-"}\n` +
        `  Traffic:   ${a.packets} packets${a.lastT !== undefined ? `, last ${ago(sim.t - a.lastT)}` : ""}\n` +
        `  Alerts:    ${alerts.length ? alerts.map((x) => `${x.id} ${x.title}`).join("; ") : "none open"}\n`,
    );
    return 0;
  }
  const rows = list.map((a) => [a.name, a.ip, a.type, a.identity ? `${a.identity.vendor} ${a.identity.product}` : sim.devices.has(a.name) ? C.gray("unknown") : a.os ?? "-", a.identity?.revision ?? "-", a.zone, a.lastT !== undefined ? ago(sim.t - a.lastT) : C.gray("not yet"), a.known ? "" : C.red("new")]);
  io.stdout(table(["NAME", "IP", "TYPE", "VENDOR / OS", "FIRMWARE", "ZONE", "LAST SEEN", ""], rows));
  io.stdout(C.gray("assets HOST for details\n"));
  return 0;
};
