// Network tools you run on a host. Everything they send goes through the
// zones and conduits, and the IDS sees what gets through.

import type { Shell, CommandFn } from "../shell.js";
import { SERVICES, SERVICE_NAMES, type Host, type ServiceName } from "../network.js";
import { DEVICE_MAPS, EXCEPTIONS, FC_NAMES, type DeviceName, type PointTable } from "../plant.js";
import { C, UserError, table } from "../util.js";
import { mapText } from "./console.js";

const wantsHelp = (args: string[]) => args.includes("--help") || args.includes("-h");

const MODBUS_HELP = `modbus read  HOST TABLE ADDR [COUNT]        TABLE: coil, di, ir or hr
modbus write HOST coil ADDR 0|1 [0|1 ...]   one value: fc 5, several: fc 15
modbus write HOST hr ADDR VALUE [VALUE ...] one value: fc 6, several: fc 16
modbus info  HOST                           vendor, model and firmware (fc 43)
modbus map   HOST                           register map from the vendor manual (no traffic)

Modbus has no login and no encryption: whoever can reach port 502 can read
and write. Examples:
  modbus read plc-1 ir 0 2      tank level and chlorine
  modbus write plc-1 hr 1 750   set the pump stop level to 75.0 %
`;

const TABLES: Record<string, { t: PointTable; fc: number; name: string }> = {
  coil: { t: "coil", fc: 1, name: "coils" },
  coils: { t: "coil", fc: 1, name: "coils" },
  co: { t: "coil", fc: 1, name: "coils" },
  di: { t: "di", fc: 2, name: "discrete inputs" },
  ir: { t: "ir", fc: 4, name: "input registers" },
  hr: { t: "hr", fc: 3, name: "holding registers" },
};

function device(sim: { net: { needHost(r: string): Host } }, ref: string): Host {
  return sim.net.needHost(ref);
}

function mapDevice(h: Host): DeviceName {
  if (h.name !== "plc-1" && h.name !== "sis-1") throw new UserError(`${h.name} is not a Modbus device. The controllers are plc-1 and sis-1.`);
  return h.name;
}

function int(text: string | undefined, what: string): number {
  if (text === undefined || !/^\d+$/.test(text)) throw new UserError(`${what} must be a whole number`);
  return parseInt(text, 10);
}

const modbus: CommandFn = (args, { io, sim, host }) => {
  const [sub, target, ...rest] = args;
  if (!sub || wantsHelp(args)) {
    io.stdout(MODBUS_HELP);
    return sub ? 0 : 1;
  }
  if (sub === "map") {
    if (!target) throw new UserError("usage: modbus map HOST");
    io.stdout(mapText(mapDevice(device(sim, target))));
    return 0;
  }
  if (!host) throw new UserError(`run this on a host so the traffic has a source, e.g. ssh hmi-01 modbus ${args.join(" ")}`);
  if (!target) throw new UserError(`usage: modbus ${sub} HOST ...`);
  const dst = device(sim, target);
  const addr = `${dst.ip}:502`;

  const send = (req: { fc: number; addr: number; count?: number; values?: number[] }) => {
    const r = sim.modbus(host.name, dst.name, req);
    if (!r.verdict.allowed) {
      io.stderr(`modbus: no response from ${addr} (timed out). Something on the path drops this traffic.\n`);
      return undefined;
    }
    if (!r.verdict.delivered || !r.reply) {
      io.stderr(`modbus: connection to ${addr} refused. Nothing listens on port 502 there.\n`);
      return undefined;
    }
    if (!r.reply.ok) {
      io.stderr(`modbus: ${dst.name} answered with exception ${r.reply.exception} (${EXCEPTIONS[r.reply.exception!] ?? "unknown"})\n`);
      return undefined;
    }
    return r.reply;
  };

  switch (sub) {
    case "read": {
      const [tableName, a, n] = rest;
      const tdef = TABLES[(tableName ?? "").toLowerCase()];
      if (!tdef) throw new UserError("usage: modbus read HOST coil|di|ir|hr ADDR [COUNT]");
      const start = int(a, "ADDR");
      const count = n === undefined ? 1 : int(n, "COUNT");
      const reply = send({ fc: tdef.fc, addr: start, count });
      if (!reply) return 1;
      io.stdout(`${dst.name} (${addr}) fc ${tdef.fc}, ${FC_NAMES[tdef.fc]}\n`);
      const defs = dst.name === "plc-1" || dst.name === "sis-1" ? DEVICE_MAPS[dst.name][tdef.t] : [];
      const rows = reply.values!.map((v, i) => {
        const d = defs.find((p) => p.addr === start + i);
        return [`${tdef.t} ${start + i}`, String(v), d ? d.tag : "", d ? d.description : ""];
      });
      io.stdout(table(["POINT", "VALUE", "TAG", "DESCRIPTION"], rows));
      return 0;
    }
    case "write": {
      const [tableName, a, ...vals] = rest;
      const t = (tableName ?? "").toLowerCase();
      if (t !== "coil" && t !== "hr" && t !== "coils") throw new UserError("usage: modbus write HOST coil|hr ADDR VALUE [VALUE ...]  (only coils and holding registers are writable)");
      const start = int(a, "ADDR");
      if (!vals.length) throw new UserError("give at least one value to write");
      const values = vals.map((v) => int(v, "VALUE"));
      const isCoil = t !== "hr";
      const fc = isCoil ? (values.length > 1 ? 15 : 5) : values.length > 1 ? 16 : 6;
      const reply = send({ fc, addr: start, values });
      if (!reply) return 1;
      const tag = dst.name === "plc-1" || dst.name === "sis-1" ? DEVICE_MAPS[dst.name][isCoil ? "coil" : "hr"].find((p) => p.addr === start)?.tag : undefined;
      io.stdout(`${dst.name} (${addr}) fc ${fc}, ${FC_NAMES[fc]}: ${isCoil ? "coil" : "hr"} ${start}${tag ? ` (${tag})` : ""} = ${values.join(",")}  ${C.green("OK")}\n`);
      return 0;
    }
    case "info": {
      const reply = send({ fc: 43, addr: 0 });
      if (!reply) return 1;
      const d = reply.deviceId!;
      io.stdout(`${dst.name} (${addr}) fc 43, ${FC_NAMES[43]}\n  VendorName:          ${d.vendor}\n  ProductCode:         ${d.product}\n  MajorMinorRevision:  ${d.revision}\n`);
      return 0;
    }
    default:
      throw new UserError(`unknown subcommand "${sub}". Try modbus --help.`);
  }
};

/** Expand a target into hosts: a name, an IP, or a /24 or /16 range. */
function targets(sim: { net: { hosts: Host[]; needHost(r: string): Host } }, text: string): { hosts: Host[]; addresses: number } {
  const cidr = text.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
  if (!cidr) return { hosts: [sim.net.needHost(text)], addresses: 1 };
  const bits = parseInt(cidr[5], 10);
  if (![16, 24, 32].includes(bits)) throw new UserError("ranges must be /16, /24 or /32");
  const parts = cidr.slice(1, 5).map((p) => parseInt(p, 10));
  const keep = bits / 8;
  const prefix = parts.slice(0, keep).join(".");
  const hosts = sim.net.hosts.filter((h) => bits === 32 ? h.ip === parts.join(".") : h.ip.split(".").slice(0, keep).join(".") === prefix);
  return { hosts, addresses: 2 ** (32 - bits) };
}

const DEFAULT_PORTS = [22, 80, 443, 502, 3389];

const nmap: CommandFn = (args, { io, sim, host }) => {
  if (!args.length || wantsHelp(args)) {
    io.stdout("nmap [-p PORTS] [-sn] TARGET\n  TARGET is a host, an IP, or a range like 10.10.10.0/24\n  -p 502,3389   ports to scan (default 22,80,443,502,3389)\n  -sn           ping scan only, no ports\nScanning is noisy: the IDS notices it.\n");
    return args.length ? 0 : 1;
  }
  let ports = DEFAULT_PORTS;
  let pingOnly = false;
  let target: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-p") {
      ports = (args[++i] ?? "").split(",").map((p) => parseInt(p, 10)).filter((p) => p > 0 && p < 65536);
      if (!ports.length) throw new UserError("-p needs ports, e.g. -p 502,3389");
    } else if (a.startsWith("-p") && a.length > 2) {
      ports = a.slice(2).split(",").map((p) => parseInt(p, 10)).filter((p) => p > 0 && p < 65536);
    } else if (a === "-sn") pingOnly = true;
    else if (a.startsWith("-")) continue;
    else target = a;
  }
  if (!target) throw new UserError("give a target, e.g. nmap 10.10.10.0/24");
  const src = host!;
  const { hosts, addresses } = targets(sim, target);
  io.stdout(`Starting scan of ${target} from ${src.name} (${src.ip})\n`);
  let up = 0;
  for (const h of hosts.filter((x) => x !== src)) {
    const ping = sim.send(src.name, h.name, "icmp");
    const results: { port: number; state: "open" | "closed" | "filtered"; service: string }[] = [];
    if (!pingOnly) {
      for (const port of ports) {
        const svc = SERVICE_NAMES.find((s) => s !== "icmp" && SERVICES[s].port === port) as ServiceName | undefined;
        if (!svc) {
          const same = h.zone === src.zone;
          results.push({ port, state: same ? "closed" : "filtered", service: "unknown" });
          continue;
        }
        const v = sim.send(src.name, h.name, svc);
        results.push({ port, state: v.delivered ? "open" : v.allowed ? "closed" : "filtered", service: svc });
      }
    }
    const reachable = ping.allowed || results.some((r) => r.state !== "filtered");
    if (!reachable) continue;
    up++;
    io.stdout(`\nScan report for ${h.name} (${h.ip})\nHost is up.\n`);
    if (pingOnly) continue;
    const open = results.filter((r) => r.state === "open");
    const closed = results.filter((r) => r.state === "closed").length;
    const filtered = results.filter((r) => r.state === "filtered").length;
    if (open.length) io.stdout(table(["PORT", "STATE", "SERVICE"], open.map((r) => [`${r.port}/tcp`, C.green("open"), r.service])));
    else io.stdout("No open ports found.\n");
    if (closed || filtered) io.stdout(C.gray(`Not shown: ${closed} closed, ${filtered} filtered\n`));
  }
  io.stdout(`\nScan done: ${addresses} address${addresses === 1 ? "" : "es"}, ${up} host${up === 1 ? "" : "s"} up.\n`);
  return 0;
};

const ping: CommandFn = (args, { io, sim, host }) => {
  if (!args.length || wantsHelp(args)) {
    io.stdout("ping HOST    check whether HOST answers (icmp)\n");
    return args.length ? 0 : 1;
  }
  const dst = sim.net.needHost(args.filter((a) => !a.startsWith("-"))[0] ?? "");
  const v = sim.send(host!.name, dst.name, "icmp");
  io.stdout(`PING ${dst.name} (${dst.ip})\n`);
  if (!v.allowed) {
    io.stdout("Request timeout for icmp_seq 1\nRequest timeout for icmp_seq 2\nRequest timeout for icmp_seq 3\n3 packets transmitted, 0 received, 100% packet loss\n");
    return 1;
  }
  for (let i = 1; i <= 3; i++) io.stdout(`64 bytes from ${dst.ip}: icmp_seq=${i} ttl=${dst.level <= 1 ? 255 : 128} time=${(0.4 + i * 0.1).toFixed(1)} ms\n`);
  io.stdout("3 packets transmitted, 3 received, 0% packet loss\n");
  return 0;
};

const curl: CommandFn = (args, { io, sim, host }) => {
  const url = args.find((a) => !a.startsWith("-"));
  if (!url || wantsHelp(args)) {
    io.stdout("curl URL    fetch a web page, e.g. curl http://hmi-01/ or curl https://hist-dmz/report\n");
    return url ? 0 : 1;
  }
  const m = url.match(/^(?:(https?):\/\/)?([^/:]+)(?::(\d+))?(\/.*)?$/);
  if (!m) throw new UserError(`bad URL "${url}"`);
  const scheme = (m[1] ?? "http") as "http" | "https";
  const dst = sim.net.needHost(m[2]);
  const v = sim.send(host!.name, dst.name, scheme);
  if (!v.allowed) {
    io.stderr(`curl: (28) Failed to connect to ${dst.name} port ${SERVICES[scheme].port}: Connection timed out\n`);
    return 28;
  }
  if (!v.delivered) {
    io.stderr(`curl: (7) Failed to connect to ${dst.name} port ${SERVICES[scheme].port}: Connection refused\n`);
    return 7;
  }
  const p = sim.plant;
  const body: Record<string, string> = {
    "hmi-01": `Riverside WTP operator HMI\nT-101 level ${p.level.toFixed(1)} %, P-101 ${p.pumpRunning ? "RUN" : "STOP"}, chlorine ${p.chlorine.toFixed(2)} mg/L\nLog in to operate.\n`,
    "plc-1": `ZS-PLC 100 web server, firmware 2.4.1\nConfiguration login: admin / admin (default password still set)\n`,
    historian: `{"source":"historian","tank_level_pct":${p.level.toFixed(1)},"chlorine_mg_l":${p.chlorine.toFixed(2)},"points":512}\n`,
    "hist-dmz": `Production report (copy in the DMZ)\nTank T-101 level ${p.level.toFixed(1)} %, chlorine ${p.chlorine.toFixed(2)} mg/L\nThis copy is read-only and refreshed from the historian every 10 s.\n`,
  };
  io.stdout(body[dst.name] ?? "OK\n");
  return 0;
};

const rdp: CommandFn = (args, { io, sim, host, shell }) => {
  if (!args.length || wantsHelp(args)) {
    io.stdout("rdp HOST    open a remote desktop session to HOST. Your commands then run on HOST.\n");
    return args.length ? 0 : 1;
  }
  const dst = sim.net.needHost(args[0]);
  const v = sim.send(host!.name, dst.name, "rdp");
  if (!v.allowed) {
    io.stderr(`rdp: could not connect to ${dst.name} (${dst.ip}:3389): the connection timed out\n`);
    return 1;
  }
  if (!v.delivered) {
    io.stderr(`rdp: ${dst.name} (${dst.ip}) refused the connection on port 3389\n`);
    return 1;
  }
  if (dst.mfa) io.stdout("MFA: push notification approved on the user's phone.\n");
  shell.stack.push(dst.name);
  io.stdout(`Remote desktop to ${C.bold(dst.name)} (${dst.ip}) as ${dst.user}, from ${host!.name}.\nCommands you run now run on ${dst.name}. Type ${C.cyan("exit")} to disconnect.\n`);
  return 0;
};

const ip: CommandFn = (args, { io, host }) => {
  if (wantsHelp(args)) {
    io.stdout("ip addr    show this host's address\n");
    return 0;
  }
  const h = host!;
  io.stdout(`1: lo: inet 127.0.0.1/8\n2: eth0: inet ${h.ip}/24\n`);
  return 0;
};

export function registerHostCommands(shell: Shell): void {
  shell.register("modbus", { run: modbus, where: "both" });
  shell.register("nmap", { run: nmap, where: "host" });
  shell.register("ping", { run: ping, where: "host" });
  shell.register("curl", { run: curl, where: "host" });
  shell.register("rdp", { run: rdp, where: "host" });
  shell.register("ip", { run: ip, where: "host" });
}
