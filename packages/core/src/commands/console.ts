// Console commands: look at the plant and the network, design zones and
// conduits, write firewall rules, and investigate alerts.

import type { Shell, CommandFn, CmdContext } from "../shell.js";
import { quote } from "../shell.js";
import { LEVEL_NAMES, ruleText, endpointText, SERVICES, type Host, type Rule, type ServiceName } from "../network.js";
import { TABLES, TABLE_NAMES } from "../modbus.js";
import type { Sim } from "../sim.js";
import { C, UserError, table, clock, ago, wrapText } from "../util.js";
import type { Severity } from "../sim.js";

const levelText = (l: number) => `${l} ${LEVEL_NAMES[String(l)] ?? ""}`.trim();

function sev(s: Severity | string): string {
  switch (s) {
    case "critical":
      return C.red(C.bold("CRITICAL"));
    case "high":
      return C.red("HIGH");
    case "medium":
      return C.yellow("MEDIUM");
    default:
      return C.gray("LOW");
  }
}

function bar(pct: number, width = 20): string {
  const n = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return "█".repeat(n) + "░".repeat(width - n);
}

/** Pull "--name value" and "--name=value" options out of the args. */
function takeOptions(args: string[], names: string[]): { opts: Record<string, string>; rest: string[] } {
  const opts: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (m && names.includes(m[1])) {
      opts[m[1]] = m[2] ?? args[++i] ?? "";
    } else rest.push(a);
  }
  return { opts, rest };
}

function needArgs(args: string[], n: number, usage: string): void {
  if (args.length < n) throw new UserError(`usage: ${usage}`);
}

const wantsHelp = (args: string[]) => args.includes("--help") || args.includes("-h");

// ---------------------------------------------------------------- hosts

const hosts: CommandFn = (args, { io, sim }) => {
  if (wantsHelp(args)) {
    io.stdout("hosts            list every host with its IP, Purdue level, zone and services\nhosts -o wide    also show the lab role and operating system\n");
    return 0;
  }
  const wide = args.includes("wide") || args.includes("-owide");
  const rows = sim.net.hosts.map((h) => {
    const r = [h.name, h.ip, levelText(h.level), h.zone, h.services.join(",") || "-", h.description];
    if (wide) r.push(h.role ?? "-", h.os);
    return r;
  });
  io.stdout(table(["NAME", "IP", "LEVEL", "ZONE", "SERVICES", "DESCRIPTION", ...(wide ? ["LAB ROLE", "OS"] : [])], rows));
  return 0;
};

const hostCmd: CommandFn = (args, { io, sim }) => {
  const usage = "host show HOST | host config HOST mfa=on|off";
  if (!args.length || wantsHelp(args)) {
    io.stdout(`usage: ${usage}\n  mfa   multi-factor authentication for remote logins (jump hosts)\n`);
    return args.length ? 0 : 1;
  }
  const [sub, name, ...rest] = args;
  if (sub === "show") {
    needArgs(args, 2, usage);
    const h = sim.net.needHost(name);
    const svc = h.services.map((s) => `${s} (${SERVICES[s].label})`).join(", ") || "none";
    io.stdout(`${C.bold(h.name)}  ${h.ip}\n  About:     ${h.description}\n  OS:        ${h.os}\n  Level:     ${levelText(h.level)}\n  Zone:      ${h.zone}\n  Services:  ${svc}\n  MFA:       ${h.mfa ? "on" : "off"}${h.role ? `\n  Lab role:  ${h.role}` : ""}${sim.device(h.name) ? `\n  Modbus:    ${sim.device(h.name)!.def.product}, see modbus map ${h.name}` : ""}\n`);
    return 0;
  }
  if (sub === "config") {
    needArgs(args, 3, usage);
    const h = sim.net.needHost(name);
    for (const kv of rest) {
      const m = kv.match(/^mfa=(on|off|true|false)$/i);
      if (!m) throw new UserError(`unknown setting "${kv}". Supported: mfa=on, mfa=off`);
      if (h.services.indexOf("rdp") < 0 && h.services.indexOf("ssh") < 0) throw new UserError(`${h.name} has no remote login service, MFA does not apply`);
      h.mfa = /on|true/i.test(m[1]);
      io.stdout(`${h.name}: MFA ${h.mfa ? "on" : "off"}. Remote logins to ${h.name} ${h.mfa ? "now need a second factor" : "only need a password"}.\n`);
    }
    return 0;
  }
  throw new UserError(`usage: ${usage}`);
};

// ---------------------------------------------------------------- plant and hmi

const plant: CommandFn = (args, { io, sim }) => {
  if (wantsHelp(args)) {
    io.stdout("plant    process values, alarms, and whether the data flows the plant needs still work\n");
    return 0;
  }
  const p = sim.tank;
  const flows = sim.requiredFlows();
  const okCount = flows.filter((f) => f.ok).length;
  const alarms = sim.plant.alarms();
  const out: string[] = [];
  out.push(`${C.bold(sim.site.name)}   plant time ${clock(sim.t)}`);
  if (p) {
    const t = p.tags;
    const pump = p.pumpRunning ? C.green("running") : "stopped";
    out.push(`  Tank ${t.tank} level`.padEnd(23) + `${p.level.toFixed(1).padStart(5)} %  ${bar(p.level)}  start ${p.startSp / 10} %, stop ${p.stopSp / 10} %`);
    out.push(`  Inlet pump ${t.pump}`.padEnd(23) + `${pump} (${p.autoMode ? "auto" : C.yellow("manual")})`);
    out.push(`  Chlorine residual    ${p.chlorine.toFixed(2)} mg/L, setpoint ${(p.chlorineSp / 100).toFixed(2)}, dosing ${p.dosingRunning ? "on" : C.red("off")}`);
    const sis = sim.site.ids.safety[0];
    out.push(`  Safety system${sis ? ` ${sis}` : ""}`.padEnd(23) + `${p.bypassed ? C.red("BYPASSED") : p.sisTrip ? C.yellow("TRIPPED") : C.green("armed")}, trips at ${p.tripSp / 10} %`);
    if (p.overflowSeconds > 0) out.push(`  Overflow             ${C.red(`${Math.round(p.overflowSeconds)} s of spillage so far`)}`);
  }
  const hmiHost = sim.site.hmi;
  if (hmiHost) out.push(`  HMI ${hmiHost.host}`.padEnd(23) + `${sim.hmiOnline ? C.green("online") : C.red(`COMM FAIL: no data from ${hmiHost.device}`)}`);
  out.push(`  Alarms               ${alarms.length ? alarms.map((a) => (a.severity === "critical" || a.severity === "high" ? C.red(a.text) : C.yellow(a.text))).join("; ") : C.green("none")}`);
  out.push(`  Data flows           ${okCount === flows.length ? C.green(`${okCount}/${flows.length} working`) : C.red(`${okCount}/${flows.length} working`)}`);
  for (const f of flows.filter((x) => !x.ok)) out.push(`    ${C.red("✘")} ${f.flow.title}\n      ${C.gray(f.reason)}`);
  io.stdout(out.join("\n") + "\n");
  return 0;
};

const hmi: CommandFn = (args, { io, sim }) => {
  const h = sim.site.hmi;
  if (wantsHelp(args)) {
    io.stdout(`hmi    the operator screen${h ? ` on ${h.host}` : ""}. It shows what the HMI last read from the controllers.\n`);
    return 0;
  }
  if (!h) {
    io.stdout("This site has no HMI defined.\n");
    return 0;
  }
  const v = sim.hmiView;
  const tags = sim.plant.tags;
  const online = sim.hmiOnline;
  const W = 52;
  const row = (s: string) => `│ ${s}${" ".repeat(Math.max(0, W - 2 - s.replace(/\x1b\[[0-9;]*m/g, "").length))} │`;
  const dot = (on: boolean) => (on ? C.green("●") : C.gray("○"));
  const title = `${h.host}  ${sim.site.name}`.slice(0, W - 2);
  const lines = [
    `┌${"─".repeat(W)}┐`,
    row(C.bold(title)),
    row(""),
    row(`${(tags.tank ?? "Tank").padEnd(6)} ${bar(v.level, 20)}  ${v.level.toFixed(1)} %`),
    row(`${tags.pump ?? "Pump"} inlet pump`.padEnd(20) + `${dot(v.pump)} ${v.pump ? "RUN" : "STOP"}    Mode ${v.auto ? "AUTO" : C.yellow("MANUAL")}`),
    row(`${tags.dosing ?? "Dosing"} dosing pump`.padEnd(20) + `${dot(v.dosing)} ${v.dosing ? "ON" : C.red("OFF")}`),
    row(`Chlorine            ${v.chlorine.toFixed(2)} mg/L`),
    row(`Safety system       ${v.bypass ? C.red("BYPASSED") : v.sisTrip ? C.yellow("TRIPPED") : C.green("ARMED")}`),
    row(""),
    row(online ? C.green("COMM OK") : C.red(`COMM FAIL  values are ${Math.round(sim.t - (sim.hmiLast[h.device] ?? 0))} s old`)),
    `└${"─".repeat(W)}┘`,
  ];
  io.stdout(lines.join("\n") + "\n");
  return 0;
};

// ---------------------------------------------------------------- zones

const ZONE_HELP = `zone list                                  list zones and their hosts
zone create NAME [--sl 1-4] [--description TEXT]
                                           create an empty zone (SL-T = target security level)
zone add ZONE HOST [HOST...]               move hosts into a zone (a host is in one zone)
zone show NAME                             hosts, conduits and settings of a zone
zone set NAME --sl 1-4                     set the target security level
zone delete NAME                           delete an empty zone and its conduits

Hosts in the same zone talk freely. Traffic between zones needs a conduit.
`;

const zone: CommandFn = (args, { io, sim }) => {
  const [sub = "list", ...rest] = args;
  if (wantsHelp(args)) {
    io.stdout(ZONE_HELP);
    return 0;
  }
  const net = sim.net;
  switch (sub) {
    case "list":
    case "ls": {
      const rows = net.zones.map((z) => [z.name, z.sl ? `SL ${z.sl}` : "-", net.hostsIn(z.name).map((h) => h.name).join(", ") || C.gray("(empty)")]);
      io.stdout(table(["NAME", "SL-T", "HOSTS"], rows));
      return 0;
    }
    case "create": {
      const { opts, rest: r } = takeOptions(rest, ["sl", "description"]);
      needArgs(r, 1, "zone create NAME [--sl 1-4]");
      const z = net.createZone(r[0], { sl: opts.sl !== undefined ? parseInt(opts.sl, 10) : undefined, description: opts.description });
      io.stdout(`zone ${z.name} created${z.sl ? ` (SL-T ${z.sl})` : ""}. Add hosts with: zone add ${z.name} HOST...\n`);
      return 0;
    }
    case "add":
    case "move": {
      needArgs(rest, 2, "zone add ZONE HOST [HOST...]");
      const moved = net.addToZone(rest[0], rest.slice(1));
      for (const m of moved) io.stdout(m.from === m.host.zone ? `${m.host.name} is already in zone ${m.host.zone}\n` : `${m.host.name} moved from ${m.from} to ${m.host.zone}\n`);
      const broken = sim.requiredFlows().filter((f) => !f.ok).length;
      if (broken) io.stdout(C.yellow(`${broken} plant data flow${broken === 1 ? " is" : "s are"} blocked now. Type plant to see which, and add conduits for them.\n`));
      return 0;
    }
    case "show": {
      needArgs(rest, 1, "zone show NAME");
      const z = net.needZone(rest[0]);
      const members = net.hostsIn(z.name);
      const conduits = net.conduits.filter((c) => c.zones.includes(z.name));
      io.stdout(`${C.bold(`zone ${z.name}`)}${z.sl ? `  SL-T ${z.sl}` : ""}\n`);
      if (z.description) io.stdout(`  ${z.description}\n`);
      io.stdout(`  Hosts:     ${members.map((h) => `${h.name} (${h.ip})`).join(", ") || "none"}\n`);
      io.stdout(`  Conduits:  ${conduits.map((c) => `${c.name} to ${c.zones.find((x) => x !== z.name)} (${c.rules.length} rule${c.rules.length === 1 ? "" : "s"})`).join(", ") || "none"}\n`);
      return 0;
    }
    case "set": {
      const { opts, rest: r } = takeOptions(rest, ["sl", "description"]);
      needArgs(r, 1, "zone set NAME --sl 1-4");
      const z = net.setZone(r[0], { sl: opts.sl !== undefined ? parseInt(opts.sl, 10) : undefined, description: opts.description });
      io.stdout(`zone ${z.name} updated${z.sl ? `: SL-T ${z.sl}` : ""}\n`);
      return 0;
    }
    case "delete":
    case "rm": {
      needArgs(rest, 1, "zone delete NAME");
      const gone = net.deleteZone(rest[0]);
      io.stdout(`zone ${rest[0].toLowerCase()} deleted${gone.length ? `, with conduit${gone.length === 1 ? "" : "s"} ${gone.map((c) => c.name).join(", ")}` : ""}\n`);
      return 0;
    }
    default:
      throw new UserError(`unknown subcommand "${sub}". Try zone --help.`);
  }
};

// ---------------------------------------------------------------- conduits

const CONDUIT_HELP = `conduit list                       list conduits
conduit create NAME ZONE_A ZONE_B  connect two zones (starts with no rules: everything denied)
conduit show NAME                  the zones and firewall rules of a conduit
conduit delete NAME                remove a conduit and its rules

A conduit is the only way traffic crosses from one zone to another.
Add firewall rules to it with fw allow and fw deny.
`;

const conduit: CommandFn = (args, { io, sim }) => {
  const [sub = "list", ...rest] = args;
  if (wantsHelp(args)) {
    io.stdout(CONDUIT_HELP);
    return 0;
  }
  const net = sim.net;
  switch (sub) {
    case "list":
    case "ls": {
      const rows = net.conduits.map((c) => [c.name, `${c.zones[0]} ↔ ${c.zones[1]}`, String(c.rules.length)]);
      io.stdout(rows.length ? table(["NAME", "ZONES", "RULES"], rows) : "No conduits. Zones cannot talk to each other.\n");
      return 0;
    }
    case "create": {
      needArgs(rest, 3, "conduit create NAME ZONE_A ZONE_B");
      const c = net.createConduit(rest[0], rest[1], rest[2]);
      io.stdout(`conduit ${c.name} created between ${c.zones[0]} and ${c.zones[1]}. It denies everything until you add rules:\n  fw allow ${c.name} from HOST to HOST SERVICE\n`);
      return 0;
    }
    case "show":
      needArgs(rest, 1, "conduit show NAME");
      return fwList([rest[0]], io, sim);
    case "delete":
    case "rm": {
      needArgs(rest, 1, "conduit delete NAME");
      const c = net.deleteConduit(rest[0]);
      io.stdout(`conduit ${c.name} deleted. Zones ${c.zones[0]} and ${c.zones[1]} can no longer talk to each other.\n`);
      return 0;
    }
    default:
      throw new UserError(`unknown subcommand "${sub}". Try conduit --help.`);
  }
};

// ---------------------------------------------------------------- firewall

const FW_HELP = `fw list [CONDUIT]                                   rules, top to bottom, with hit counts
fw allow CONDUIT from SRC to DST SERVICE [fc CODES] [at N]
fw deny  CONDUIT from SRC to DST SERVICE [at N]
fw delete CONDUIT N                                 delete rule N
fw log [N]                                          the last N blocked connections (default 15)

SRC and DST are a host, a zone, or any. SERVICE is modbus, http, https, rdp,
ssh, icmp, any or tcp/PORT. Rules are one-way: allow hmi-01 to plc-1 does not
let plc-1 start connections to hmi-01. First matching rule wins, and anything
no rule allows is denied.

Modbus deep packet inspection: "fc 3,4" lets only those function codes through.
  fc read  = 1,2,3,4,43        fc write = 5,6,15,16
Example: fw allow ops-control from historian to plc-1 modbus fc 3,4
`;

function fwList(args: string[], io: CmdContext["io"], sim: CmdContext["sim"]): number {
  const net = sim.net;
  const list = args.length ? args.map((a) => net.needConduit(a)) : net.conduits;
  if (!list.length) {
    io.stdout("No conduits yet. Create one with conduit create NAME ZONE_A ZONE_B.\n");
    return 0;
  }
  for (const c of list) {
    io.stdout(`${C.bold(`conduit ${c.name}`)}  (${c.zones[0]} ↔ ${c.zones[1]})\n`);
    c.rules.forEach((r: Rule, i: number) => {
      const act = r.action === "allow" ? C.green("allow") : C.red("deny ");
      const fc = r.fc ? ` fc ${r.fc.join(",")}` : "";
      io.stdout(`  ${String(i + 1).padStart(2)}  ${act}  ${endpointText(r.src)} → ${endpointText(r.dst)}  ${r.service}${fc}  ${C.gray(`(${r.hits} hit${r.hits === 1 ? "" : "s"})`)}\n`);
    });
    io.stdout(`  ${C.gray(" *  deny   everything else")}\n`);
  }
  return 0;
}

function parseRule(sim: CmdContext["sim"], action: "allow" | "deny", args: string[]): { conduit: string; rule: Omit<Rule, "hits">; at?: number } {
  const usage = `fw ${action} CONDUIT from SRC to DST SERVICE${action === "allow" ? " [fc CODES]" : ""} [at N]`;
  const [conduit, ...rest] = args;
  if (!conduit) throw new UserError(`usage: ${usage}`);
  sim.net.needConduit(conduit);
  const words: string[] = [];
  let fc: number[] | undefined;
  let at: number | undefined;
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i].toLowerCase();
    if (w === "from" || w === "to") continue;
    if (w === "fc" || w === "--fc") {
      if (!rest[i + 1]) throw new UserError("fc needs a list of function codes, e.g. fc 3,4");
      fc = sim.net.parseFunctionCodes(rest[++i]);
      continue;
    }
    if (w.startsWith("fc=")) {
      fc = sim.net.parseFunctionCodes(w.slice(3));
      continue;
    }
    if (w === "at" || w === "--at") {
      at = parseInt(rest[++i] ?? "", 10);
      if (!Number.isInteger(at) || at < 1) throw new UserError("at needs a rule number, e.g. at 1");
      continue;
    }
    words.push(rest[i]);
  }
  if (words.length !== 3) throw new UserError(`usage: ${usage}`);
  if (fc && action === "deny") throw new UserError("function code lists go on allow rules. Traffic that matches no allow rule is denied anyway.");
  const [src, dst, service] = words;
  const rule: Omit<Rule, "hits"> = { action, src: sim.net.parseEndpoint(src), dst: sim.net.parseEndpoint(dst), service: sim.net.parseService(service) };
  if (fc) rule.fc = fc;
  return { conduit, rule, at };
}

const fw: CommandFn = (args, { io, sim }) => {
  const [sub = "list", ...rest] = args;
  if (wantsHelp(args)) {
    io.stdout(FW_HELP);
    return 0;
  }
  const net = sim.net;
  switch (sub) {
    case "list":
    case "ls":
    case "show":
      return fwList(rest, io, sim);
    case "allow":
    case "deny": {
      const { conduit: name, rule, at } = parseRule(sim, sub, rest);
      const { index, warnings } = net.addRule(name, rule, at);
      const c = net.needConduit(name);
      io.stdout(`conduit ${c.name} rule ${index}: ${ruleText(c.rules[index - 1])}\n`);
      for (const w of warnings) io.stdout(C.yellow(`warning: ${w}\n`));
      return 0;
    }
    case "delete":
    case "rm": {
      needArgs(rest, 2, "fw delete CONDUIT N");
      const r = net.deleteRule(rest[0], parseInt(rest[1], 10));
      io.stdout(`deleted rule ${rest[1]} from conduit ${rest[0].toLowerCase()}: ${ruleText(r)}\n`);
      return 0;
    }
    case "log": {
      const n = parseInt(rest[0] ?? "15", 10) || 15;
      const entries = sim.fwlog.slice(-n);
      if (!entries.length) {
        io.stdout("Nothing blocked yet.\n");
        return 0;
      }
      io.stdout(table(["TIME", "CONDUIT", "FROM", "TO", "SERVICE", "REASON"], entries.map((e) => [clock(e.t), e.conduit, e.src, e.dst, e.service + (e.fc !== undefined ? ` fc ${e.fc}` : ""), e.reason])));
      return 0;
    }
    default:
      throw new UserError(`unknown subcommand "${sub}". Try fw --help.`);
  }
};

const test: CommandFn = (args, { io, sim }) => {
  const usage = "test SRC DST SERVICE [fc N]";
  if (wantsHelp(args)) {
    io.stdout(`${usage}\n  Checks whether traffic would get through, without sending anything.\n  Example: test corp-pc plc-1 modbus fc 6\n`);
    return 0;
  }
  const { opts, rest } = takeOptions(args, ["fc"]);
  let fc = opts.fc !== undefined ? parseInt(opts.fc, 10) : undefined;
  const words = [...rest];
  const fcAt = words.findIndex((w) => w.toLowerCase() === "fc");
  if (fcAt >= 0) {
    fc = parseInt(words[fcAt + 1] ?? "", 10);
    words.splice(fcAt, 2);
  }
  if (words.length !== 3) throw new UserError(`usage: ${usage}`);
  const src = sim.net.needHost(words[0]);
  const dst = sim.net.needHost(words[1]);
  const service = sim.net.parseService(words[2]);
  if (service === "any" || service.startsWith("tcp/")) throw new UserError("test needs a named service: modbus, http, https, rdp, ssh or icmp");
  if (fc !== undefined && (!Number.isInteger(fc) || service !== "modbus")) throw new UserError("fc only applies to modbus, e.g. test hmi-01 plc-1 modbus fc 6");
  const v = sim.net.evaluate(src, dst, service as ServiceName, fc);
  const what = `${src.name} → ${dst.name} ${service}${fc !== undefined ? ` fc ${fc}` : ""}`;
  if (!v.allowed) io.stdout(`${C.red("✘ blocked")}  ${what}\n  ${v.reason}\n`);
  else if (!v.delivered) io.stdout(`${C.yellow("✔ allowed, but nothing listens")}  ${what}\n  ${v.reason}. ${dst.name} does not offer ${service}.\n`);
  else io.stdout(`${C.green("✔ allowed")}  ${what}\n  ${v.reason}\n`);
  return v.delivered ? 0 : 1;
};

// ---------------------------------------------------------------- monitoring

const flows: CommandFn = (args, { io, sim }) => {
  if (wantsHelp(args)) {
    io.stdout("flows [--blocked] [--mine] [HOST]\n  Conversations seen on the network, newest first.\n  --blocked  only conversations whose last attempt was blocked\n  --mine     only traffic you started (not the plant's own polling)\n");
    return 0;
  }
  const blocked = args.includes("--blocked");
  const mine = args.includes("--mine");
  const host = args.find((a) => !a.startsWith("-"));
  if (host) sim.net.needHost(host);
  let list = [...sim.conversations.values()].sort((a, b) => b.lastT - a.lastT);
  if (blocked) list = list.filter((c) => !c.lastOk);
  if (mine) list = list.filter((c) => !c.background);
  if (host) list = list.filter((c) => c.src === host.toLowerCase() || c.dst === host.toLowerCase() || sim.net.host(host)?.name === c.src || sim.net.host(host)?.name === c.dst);
  if (!list.length) {
    io.stdout("No matching conversations.\n");
    return 0;
  }
  const rows = list.map((c) => [c.src, c.dst, c.service, c.fcs.length ? c.fcs.join(",") : "-", String(c.count), ago(sim.t - c.lastT), c.background ? "plant" : "you", c.lastOk ? C.green("ok") : C.red("blocked")]);
  io.stdout(table(["FROM", "TO", "SERVICE", "FC", "COUNT", "LAST", "BY", "STATUS"], rows));
  return 0;
};

const alerts: CommandFn = (args, { io, sim }) => {
  const [sub, ...rest] = args;
  if (wantsHelp(args)) {
    io.stdout("alerts               open alerts from the IDS sensor and the process\nalerts --all         include acknowledged alerts\nalerts show ID       details of one alert\nalerts ack ID|all    acknowledge (you have looked at it)\n");
    return 0;
  }
  if (sub === "show") {
    needArgs(rest, 1, "alerts show ID");
    const a = sim.alerts.find((x) => x.id.toLowerCase() === rest[0].toLowerCase());
    if (!a) throw new UserError(`no alert ${rest[0]}`);
    io.stdout(`${C.bold(a.id)}  ${sev(a.severity)}  ${a.title}\n  First seen ${clock(a.t)}, last ${clock(a.lastT)}, ${a.count} time${a.count === 1 ? "" : "s"}${a.acked ? ", acknowledged" : ""}\n  Source:  ${a.source === "ids" ? "IDS sensor" : "process"}${a.src ? `\n  From:    ${a.src} (${sim.net.host(a.src)?.ip ?? "?"})` : ""}${a.dst ? `\n  To:      ${a.dst}` : ""}\n${wrapText(a.detail, 76, "  ")}\n`);
    return 0;
  }
  if (sub === "ack") {
    needArgs(rest, 1, "alerts ack ID|all");
    const targets = rest[0] === "all" ? sim.alerts.filter((a) => !a.acked) : sim.alerts.filter((a) => rest.map((r) => r.toLowerCase()).includes(a.id.toLowerCase()));
    if (!targets.length) throw new UserError(rest[0] === "all" ? "no open alerts" : `no alert ${rest.join(", ")}`);
    for (const a of targets) a.acked = true;
    io.stdout(`acknowledged ${targets.map((a) => a.id).join(", ")}\n`);
    return 0;
  }
  const all = sub === "--all" || sub === "-a";
  const list = sim.alerts.filter((a) => all || !a.acked).slice().reverse();
  if (!list.length) {
    io.stdout(all ? "No alerts yet.\n" : "No open alerts.\n");
    return 0;
  }
  const rows = list.map((a) => [a.id, clock(a.lastT), sev(a.severity), a.title + (a.count > 1 ? C.gray(` (x${a.count})`) : ""), a.src ?? "-", ...(all ? [a.acked ? "acked" : "open"] : [])]);
  io.stdout(table(["ID", "TIME", "SEVERITY", "ALERT", "FROM", ...(all ? ["STATE"] : [])], rows));
  io.stdout(C.gray(`alerts show ID for details, alerts ack ID once handled\n`));
  return 0;
};

const report: CommandFn = (args, { io, sim }) => {
  if (wantsHelp(args)) {
    io.stdout("report    a design review: zones, conduits, the plant's data flows, and security checks\n");
    return 0;
  }
  const net = sim.net;
  const out: string[] = [C.bold("Zones")];
  out.push(table(["ZONE", "SL-T", "HOSTS"], net.zones.map((z) => [z.name, z.sl ? String(z.sl) : "-", net.hostsIn(z.name).map((h) => h.name).join(", ") || "-"])).trimEnd());
  out.push("", C.bold("Conduits"));
  out.push(net.conduits.length ? table(["CONDUIT", "ZONES", "ALLOW", "DENY"], net.conduits.map((c) => [c.name, `${c.zones[0]} ↔ ${c.zones[1]}`, String(c.rules.filter((r) => r.action === "allow").length), String(c.rules.filter((r) => r.action === "deny").length)])).trimEnd() : "  none");
  const flowsList = sim.requiredFlows();
  out.push("", C.bold(`Plant data flows  ${flowsList.filter((f) => f.ok).length}/${flowsList.length} working`));
  for (const f of flowsList) out.push(`  ${f.ok ? C.green("✔") : C.red("✘")} ${f.flow.title}${f.ok ? "" : `\n      ${C.gray(f.reason)}`}`);
  const risks = sim.risks();
  out.push("", C.bold(`Security checks  ${risks.filter((r) => r.ok).length}/${risks.length} passed`));
  for (const r of risks) out.push(`  ${r.ok ? C.green("✔") : C.red("✘")} ${r.title}\n      ${C.gray(r.detail)}`);
  io.stdout(out.join("\n") + "\n");
  return 0;
};

// ---------------------------------------------------------------- ssh and modbus map

/** ssh from the console uses the management network; from a host it crosses the plant network. */
export const ssh: CommandFn = async (args, ctx) => {
  const { io, sim, shell, host } = ctx;
  if (!args.length || wantsHelp(args)) {
    io.stdout(host ? "ssh HOST [COMMAND]   log in to another host over the network (needs ssh on the target)\n" : "ssh HOST [COMMAND]   log in to a host over the management network\n                     with a COMMAND, run it there and come back\n");
    return args.length ? 0 : 1;
  }
  const target = sim.net.needHost(args[0]);
  const command = args.slice(1);
  if (!host) {
    if (sim.device(target.name)) {
      const from = sim.site.hmi?.host ?? sim.net.hosts.find((h) => h.level === 2)?.name ?? "HOST";
      throw new UserError(`${target.name} is a controller, you cannot log in to it. Talk to it with modbus from a host, e.g. ssh ${from} modbus read ${target.name} hr 0 3`);
    }
    if (command.length) return shell.onHost(target.name, quote(command), io);
    shell.stack.push(target.name);
    io.stdout(`Connected to ${C.bold(target.name)} (${target.ip}) over the management network as ${target.user}.\nCommands you run here send traffic from ${target.name}. Type ${C.cyan("exit")} to go back.\n`);
    return 0;
  }
  const v = sim.send(host.name, target.name, "ssh");
  if (!v.allowed) {
    io.stderr(`ssh: connect to host ${target.name} (${target.ip}) port 22: Connection timed out\n`);
    return 255;
  }
  if (!v.delivered) {
    io.stderr(`ssh: connect to host ${target.name} (${target.ip}) port 22: Connection refused\n`);
    return 255;
  }
  if (target.mfa) io.stdout("MFA: push notification approved.\n");
  if (command.length) return shell.onHost(target.name, quote(command), io);
  shell.stack.push(target.name);
  io.stdout(`Logged in to ${C.bold(target.name)} (${target.ip}) over ssh from ${host.name}. Type ${C.cyan("exit")} to disconnect.\n`);
  return 0;
};

export function mapText(sim: Sim, host: string): string {
  const d = sim.device(host);
  if (!d) throw new UserError(`${host} is not a Modbus device. Devices in this site: ${[...sim.devices.keys()].join(", ") || "none"}`);
  const m = d.def;
  const out = [`${C.bold(`${host}: ${m.title}`)}   ${m.vendor} ${m.product}, firmware ${m.revision}`, `Modbus TCP port 502, unit id 1. Addresses are 0-based.`];
  for (const t of TABLES) {
    if (!m.points[t].length) continue;
    out.push("", C.bold(TABLE_NAMES[t]));
    for (const p of m.points[t]) out.push(`  ${t} ${p.addr}  ${p.tag.padEnd(14)} ${p.description}${p.units ? C.gray(` (${p.units})`) : ""}`);
  }
  return out.join("\n") + "\n";
}

export function registerConsole(shell: Shell): void {
  const con = (run: CommandFn, summary?: string) => ({ run, where: "console" as const, summary });
  shell.register("hosts", con(hosts));
  shell.register("host", con(hostCmd));
  shell.register("plant", con(plant));
  shell.register("hmi", con(hmi));
  shell.register("zone", con(zone));
  shell.register("zones", con((a, c) => zone(["list", ...a], c)));
  shell.register("conduit", con(conduit));
  shell.register("conduits", con((a, c) => conduit(["list", ...a], c)));
  shell.register("fw", con(fw));
  shell.register("test", con(test));
  shell.register("flows", con(flows));
  shell.register("alerts", con(alerts));
  shell.register("report", con(report));
  shell.register("ssh", { run: ssh, where: "both" });
}

export type { Host };
