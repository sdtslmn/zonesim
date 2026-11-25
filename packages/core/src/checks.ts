// What the plant needs to keep working (required data flows, from the site
// file), and the design checks a reviewer would run on zones and conduits.
// Checks find hosts by role and Purdue level, so they work on any site; a
// check that needs a role the site does not have is left out.

import { WRITE_FCS } from "./modbus.js";
import { endpointText, type Host, type Network, type ServiceName } from "./network.js";
import type { Site, SiteFlow, SiteHop } from "./site.js";

export interface FlowStatus {
  flow: SiteFlow;
  ok: boolean;
  reason: string;
}

function hopStatus(net: Network, hop: SiteHop): { ok: boolean; reason: string } {
  const src = net.host(hop.from);
  const dst = net.host(hop.to);
  if (!src || !dst) return { ok: false, reason: `${hop.from} → ${hop.to}: unknown host` };
  for (const fc of hop.fc ?? [undefined]) {
    const v = net.evaluate(src, dst, hop.service as ServiceName, fc);
    if (!v.delivered) return { ok: false, reason: `${hop.from} → ${hop.to} ${hop.service}${fc !== undefined ? ` fc ${fc}` : ""}: ${v.reason}` };
  }
  return { ok: true, reason: "" };
}

export function requiredFlowStatus(net: Network, flows: SiteFlow[]): FlowStatus[] {
  return flows.map((flow) => {
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

export const RISK_IDS = ["segmented", "office-to-control", "internet-dmz-only", "sis-own-zone", "sis-read-only", "historian-read-only", "remote-access", "least-privilege"];

export function riskChecks(net: Network, site: Site): RiskCheck[] {
  const out: RiskCheck[] = [];
  const hosts = net.hosts;
  const role = (r: string) => hosts.find((h) => h.role === r);

  // Office, DMZ, plant and internet hosts live in different zones.
  const mixed = net.zones.map((z) => ({ z, groups: [...new Set(net.hostsIn(z.name).map(GROUP))] })).filter((x) => x.groups.length > 1);
  out.push({
    id: "segmented",
    title: "Office, DMZ and plant hosts are in separate zones",
    ok: mixed.length === 0,
    detail: mixed.length ? mixed.map((x) => `zone ${x.z.name} mixes ${x.groups.join(", ")} hosts`).join("; ") : "every zone holds one kind of host",
  });

  // Nothing in the office reaches the control network.
  const office = hosts.filter((h) => h.level === 4);
  const control = hosts.filter((h) => h.level <= 2);
  if (office.length && control.length) {
    let leak = "";
    for (const s of office) for (const d of control) if (!leak) {
      const svc = reaches(net, s, d);
      if (svc) leak = `${s.name} reaches ${d.name} over ${svc}`;
    }
    out.push({ id: "office-to-control", title: "The office cannot reach the control network", ok: !leak, detail: leak || "no office host reaches a level 0 to 2 host" });
  }

  // The internet only reaches the DMZ.
  const internet = hosts.filter((h) => h.level >= 5);
  if (internet.length) {
    let inet = "";
    for (const s of internet) for (const d of hosts.filter((h) => h.level < 5 && h.level !== 3.5)) if (!inet) {
      const svc = reaches(net, s, d);
      if (svc) inet = `${s.name} reaches ${d.name} over ${svc}`;
    }
    out.push({ id: "internet-dmz-only", title: "The internet only reaches the DMZ", ok: !inet, detail: inet || "internet hosts reach DMZ hosts only" });
  }

  // Safety systems: own zone, and read-only from the network.
  const safety = site.ids.safety.map((n) => net.host(n)).filter((h): h is Host => !!h);
  if (safety.length) {
    const crowded = safety.map((s) => ({ s, mates: net.hostsIn(s.zone).filter((h) => !safety.includes(h)) })).filter((x) => x.mates.length);
    out.push({
      id: "sis-own-zone",
      title: "The safety system sits in its own zone",
      ok: crowded.length === 0,
      detail: crowded.length ? crowded.map((x) => `zone ${x.s.zone} also holds ${x.mates.map((h) => h.name).join(", ")}`).join("; ") : `${safety.map((s) => s.name).join(", ")} in a zone of ${safety.length === 1 ? "its" : "their"} own`,
    });
    let writer = "";
    for (const sis of safety) for (const s of hosts) if (s !== sis && !writer) for (const fc of WRITE_FCS) if (net.evaluate(s, sis, "modbus", fc).delivered) {
      writer = `${s.name} can send function code ${fc} to ${sis.name}`;
      break;
    }
    out.push({ id: "sis-read-only", title: "No host can write to the safety system", ok: !writer, detail: writer || "Modbus writes to the safety system are blocked from every host" });
  }

  // The historian only reads.
  const hist = role("historian");
  const controllers = Object.keys(site.devices).filter((d) => !site.ids.safety.includes(d)).map((d) => net.host(d)).filter((h): h is Host => !!h);
  if (hist && controllers.length) {
    let bad = "";
    for (const d of controllers) if (!bad) {
      const fc = WRITE_FCS.find((f) => net.evaluate(hist, d, "modbus", f).delivered);
      if (fc !== undefined) bad = `${hist.name} can send function code ${fc} to ${d.name}`;
    }
    out.push({ id: "historian-read-only", title: "The historian can only read the controllers", ok: !bad, detail: bad || `Modbus writes from ${hist.name} are blocked` });
  }

  // Remote access goes through the jump host, with MFA.
  const vendor = role("vendor");
  const ews = role("ews");
  const jump = role("jump");
  if (vendor && ews && jump) {
    const direct = net.evaluate(vendor, ews, "rdp").delivered || net.evaluate(vendor, ews, "ssh").delivered;
    out.push({
      id: "remote-access",
      title: `Remote access goes through ${jump.name} with MFA`,
      ok: !direct && jump.mfa,
      detail: direct ? `${vendor.name} reaches ${ews.name} directly` : !jump.mfa ? `MFA is off on ${jump.name}` : `no direct path from the internet, MFA on at ${jump.name}`,
    });
  }

  // Least privilege: no "any" in allow rules.
  const broad = net.conduits.flatMap((c) => c.rules.map((r, i) => ({ c, r, i }))).filter(({ r }) => r.action === "allow" && (r.src.type === "any" || r.dst.type === "any" || r.service === "any"));
  out.push({
    id: "least-privilege",
    title: 'Allow rules name hosts and services (no "any")',
    ok: broad.length === 0,
    detail: broad.length ? broad.map(({ c, r, i }) => `${c.name} rule ${i + 1} (${endpointText(r.src)} to ${endpointText(r.dst)} ${r.service})`).join("; ") : "no allow rule uses any",
  });

  return out;
}
