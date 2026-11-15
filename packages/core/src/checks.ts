// What the plant needs to keep working (required data flows), and the
// design checks a reviewer would run on the zones and conduits.

import { WRITE_FCS } from "./plant.js";
import { endpointText, type Host, type Network, type ServiceName } from "./network.js";

export interface Hop {
  from: string;
  to: string;
  service: ServiceName;
  /** Modbus function codes this flow needs. */
  fc?: number[];
}

export interface RequiredFlow {
  id: string;
  title: string;
  why: string;
  /** Any one path working is enough. */
  paths: Hop[][];
}

export const REQUIRED_FLOWS: RequiredFlow[] = [
  {
    id: "hmi-plc",
    title: "hmi-01 → plc-1 Modbus read and write",
    why: "Operators watch and control the process from the HMI.",
    paths: [[{ from: "hmi-01", to: "plc-1", service: "modbus", fc: [1, 2, 3, 4, 5, 6] }]],
  },
  {
    id: "hmi-sis",
    title: "hmi-01 → sis-1 Modbus read",
    why: "Operators see the safety system status on the HMI.",
    paths: [[{ from: "hmi-01", to: "sis-1", service: "modbus", fc: [2, 4] }]],
  },
  {
    id: "historian-plc",
    title: "historian → plc-1 Modbus read",
    why: "The historian records the process values.",
    paths: [[{ from: "historian", to: "plc-1", service: "modbus", fc: [3, 4] }]],
  },
  {
    id: "historian-sis",
    title: "historian → sis-1 Modbus read",
    why: "The historian records the safety system values.",
    paths: [[{ from: "historian", to: "sis-1", service: "modbus", fc: [2, 4] }]],
  },
  {
    id: "ews-plc",
    title: "ews-01 → plc-1 Modbus engineering access",
    why: "Engineers maintain the PLC settings from the engineering workstation.",
    paths: [[{ from: "ews-01", to: "plc-1", service: "modbus", fc: [1, 2, 3, 4, 5, 6, 15, 16, 43] }]],
  },
  {
    id: "historian-replica",
    title: "historian → hist-dmz HTTPS replication",
    why: "The historian copies data to the DMZ so the office never touches the plant.",
    paths: [[{ from: "historian", to: "hist-dmz", service: "https" }]],
  },
  {
    id: "office-reports",
    title: "corp-pc → hist-dmz HTTPS reports",
    why: "Office staff read production reports from the DMZ copy.",
    paths: [[{ from: "corp-pc", to: "hist-dmz", service: "https" }]],
  },
  {
    id: "vendor-support",
    title: "vendor-laptop → ews-01 remote desktop",
    why: "The vendor supports the plant remotely, directly or through jump-01.",
    paths: [
      [
        { from: "vendor-laptop", to: "jump-01", service: "rdp" },
        { from: "jump-01", to: "ews-01", service: "rdp" },
      ],
      [{ from: "vendor-laptop", to: "ews-01", service: "rdp" }],
    ],
  },
];

export interface FlowStatus {
  flow: RequiredFlow;
  ok: boolean;
  reason: string;
}

function hopStatus(net: Network, hop: Hop): { ok: boolean; reason: string } {
  const src = net.host(hop.from)!;
  const dst = net.host(hop.to)!;
  for (const fc of hop.fc ?? [undefined]) {
    const v = net.evaluate(src, dst, hop.service, fc);
    if (!v.delivered) return { ok: false, reason: `${hop.from} → ${hop.to} ${hop.service}${fc !== undefined ? ` fc ${fc}` : ""}: ${v.reason}` };
  }
  return { ok: true, reason: "" };
}

export function requiredFlowStatus(net: Network): FlowStatus[] {
  return REQUIRED_FLOWS.map((flow) => {
    let firstReason = "";
    for (const path of flow.paths) {
      const bad = path.map((h) => hopStatus(net, h)).find((s) => !s.ok);
      if (!bad) return { flow, ok: true, reason: "" };
      firstReason ||= bad.reason;
    }
    return { flow, ok: false, reason: firstReason };
  });
}

export interface RiskCheck {
  id: string;
  title: string;
  ok: boolean;
  detail: string;
}

const GROUP = (h: Host) => (h.level >= 5 ? "internet" : h.level >= 4 ? "office" : h.level >= 3.5 ? "DMZ" : "plant");

/** Can src open any service on dst? Returns the first service that gets through. */
function reaches(net: Network, src: Host, dst: Host): string | undefined {
  for (const s of dst.services) if (net.evaluate(src, dst, s).delivered) return s;
  return undefined;
}

export function riskChecks(net: Network): RiskCheck[] {
  const out: RiskCheck[] = [];
  const hosts = net.hosts;

  // 1. Office, DMZ, plant and internet hosts live in different zones.
  const mixed = net.zones
    .map((z) => ({ z, groups: [...new Set(net.hostsIn(z.name).map(GROUP))] }))
    .filter((x) => x.groups.length > 1);
  out.push({
    id: "segmented",
    title: "Office, DMZ and plant hosts are in separate zones",
    ok: mixed.length === 0,
    detail: mixed.length ? mixed.map((x) => `zone ${x.z.name} mixes ${x.groups.join(", ")} hosts`).join("; ") : "every zone holds one kind of host",
  });

  // 2. Nothing in the office reaches the control network.
  const office = hosts.filter((h) => h.level === 4);
  const control = hosts.filter((h) => h.level <= 2);
  let leak = "";
  for (const s of office) for (const d of control) if (!leak) {
    const svc = reaches(net, s, d);
    if (svc) leak = `${s.name} reaches ${d.name} over ${svc}`;
  }
  out.push({ id: "office-to-control", title: "The office cannot reach the control network", ok: !leak, detail: leak || "no office host reaches a level 1 or 2 host" });

  // 3. The internet only reaches the DMZ.
  let inet = "";
  for (const s of hosts.filter((h) => h.level >= 5)) for (const d of hosts.filter((h) => h.level < 5 && h.level !== 3.5)) if (!inet) {
    const svc = reaches(net, s, d);
    if (svc) inet = `${s.name} reaches ${d.name} over ${svc}`;
  }
  out.push({ id: "internet-dmz-only", title: "The internet only reaches the DMZ", ok: !inet, detail: inet || "internet hosts reach DMZ hosts only" });

  // 4. The safety system has a zone of its own.
  const sis = net.host("sis-1")!;
  const sisMates = net.hostsIn(sis.zone).filter((h) => h !== sis);
  out.push({
    id: "sis-own-zone",
    title: "The safety system sits in its own zone",
    ok: sisMates.length === 0,
    detail: sisMates.length ? `zone ${sis.zone} also holds ${sisMates.map((h) => h.name).join(", ")}` : `sis-1 is alone in zone ${sis.zone}`,
  });

  // 5. Nobody can write to the safety system over the network.
  let sisWriter = "";
  for (const s of hosts) if (s !== sis && !sisWriter) for (const fc of WRITE_FCS) if (net.evaluate(s, sis, "modbus", fc).delivered) {
    sisWriter = `${s.name} can send function code ${fc} to sis-1`;
    break;
  }
  out.push({ id: "sis-read-only", title: "No host can write to the safety system", ok: !sisWriter, detail: sisWriter || "Modbus writes to sis-1 are blocked from every host" });

  // 6. The historian only reads.
  const hist = net.host("historian")!;
  const plc = net.host("plc-1")!;
  const histWrite = WRITE_FCS.find((fc) => net.evaluate(hist, plc, "modbus", fc).delivered);
  out.push({
    id: "historian-read-only",
    title: "The historian can only read the PLC",
    ok: histWrite === undefined,
    detail: histWrite === undefined ? "Modbus writes from historian to plc-1 are blocked" : `historian can send function code ${histWrite} to plc-1`,
  });

  // 7. Remote access goes through the jump host, with MFA.
  const vendor = net.host("vendor-laptop")!;
  const ews = net.host("ews-01")!;
  const jump = net.host("jump-01")!;
  const direct = net.evaluate(vendor, ews, "rdp").delivered;
  out.push({
    id: "remote-access",
    title: "Remote access goes through jump-01 with MFA",
    ok: !direct && jump.mfa,
    detail: direct ? "vendor-laptop reaches ews-01 directly over rdp" : !jump.mfa ? "MFA is off on jump-01" : "no direct path from the internet, MFA on at jump-01",
  });

  // 8. Least privilege: no "any" in allow rules.
  const broad = net.conduits.flatMap((c) => c.rules.map((r, i) => ({ c, r, i }))).filter(({ r }) => r.action === "allow" && (r.src.type === "any" || r.dst.type === "any" || r.service === "any"));
  out.push({
    id: "least-privilege",
    title: 'Allow rules name hosts and services (no "any")',
    ok: broad.length === 0,
    detail: broad.length ? broad.map(({ c, r, i }) => `${c.name} rule ${i + 1} (${endpointText(r.src)} to ${endpointText(r.dst)} ${r.service})`).join("; ") : "no allow rule uses any",
  });

  return out;
}
