// The OT monitoring sensor: a passive IDS on a mirror port of the plant
// switches. From the traffic it sees it builds an asset inventory and a map of
// who talks to whom, and it compares that traffic with a baseline.
//
// The baseline is what the sensor learned while it was commissioned: the
// plant's polling and the data flows the site file lists. In learning mode it
// adds whatever it sees to the baseline. In protecting mode anything outside
// the baseline is an anomaly: a new link, or a new Modbus function code on a
// known link. Leave a sensor learning during an intrusion and the intrusion
// becomes normal.

import type { Host, ServiceName } from "./network.js";
import type { Site } from "./site.js";
import { FC_NAMES, WRITE_FCS } from "./modbus.js";

export type SensorMode = "learning" | "protecting";

/** One link (who talks to whom, over what) as the sensor records it. */
export interface LinkObs {
  src: string;
  dst: string;
  service: ServiceName;
  fc?: number;
}

export interface BaselineLink {
  id: number;
  src: string;
  dst: string;
  service: ServiceName;
  /** Modbus function codes learned on the link. */
  fcs: number[];
  /** A Modbus link the site file lists without function codes: any is normal. */
  anyFc?: boolean;
  /** How it got into the baseline. */
  how: "commissioning" | "learning" | "alert";
  /** Plant time it was learned, for links learned after commissioning. */
  t?: number;
}

export interface SeenLink {
  src: string;
  dst: string;
  service: ServiceName;
  fcs: number[];
  packets: number;
  /** Packets the destination answered: it offers the service. */
  answered: number;
  writes: number;
  firstT: number;
  lastT: number;
}

export interface Anomaly {
  kind: "new-link" | "new-fc";
  link: LinkObs;
}

export interface DeviceIdentity {
  vendor: string;
  product: string;
  revision: string;
  /** When the sensor saw it: "commissioning" or a plant time. */
  t?: number;
}

export interface Asset {
  name: string;
  ip: string;
  zone: string;
  type: string;
  os?: string;
  identity?: DeviceIdentity;
  /** Services it answers on, from the links it receives. */
  serves: string[];
  /** Services it uses on other hosts. */
  uses: string[];
  peers: string[];
  /** In the baseline: the sensor knew it before the simulation started. */
  known: boolean;
  firstT?: number;
  lastT?: number;
  packets: number;
}

const ROLE_TYPES: Record<string, string> = {
  plc: "controller",
  tvs: "controller",
  meter: "controller",
  sis: "safety controller",
  hmi: "HMI / SCADA server",
  "backup-centre": "SCADA server (backup centre)",
  "control-centre": "SCADA server (control centre)",
  ews: "engineering workstation",
  historian: "historian",
  "report-server": "DMZ server",
  jump: "jump host",
  office: "office PC",
  vendor: "remote vendor (internet)",
  customer: "customer system",
};

const KIND_TYPES: Record<Host["kind"], string> = { external: "internet host", it: "IT host", dmz: "DMZ server", ot: "OT host" };

const linkKey = (src: string, dst: string, service: string) => `${src}>${dst}>${service}`;

export class Sensor {
  mode: SensorMode = "protecting";
  baseline: BaselineLink[] = [];
  seen = new Map<string, SeenLink>();
  identities = new Map<string, DeviceIdentity>();
  private nextId = 1;

  constructor(private site: Site) {
    this.commission();
  }

  /** The baseline learned while the sensor was commissioned: polling and the site's data flows. */
  private commission(): void {
    for (const p of this.site.polling) this.addToBaseline({ src: p.from, dst: p.to, service: p.service as ServiceName }, p.service === "modbus" ? p.fc ?? [3] : [], "commissioning");
    for (const f of this.site.flows)
      for (const path of f.paths) for (const h of path) this.addToBaseline({ src: h.from, dst: h.to, service: h.service as ServiceName }, h.service === "modbus" ? h.fc ?? [] : [], "commissioning", h.service === "modbus" && !h.fc);
    // Controllers that an engineering workstation read device identification from while the sensor learned.
    for (const b of this.baseline) {
      if (b.service !== "modbus" || !b.fcs.includes(43)) continue;
      const dev = this.site.devices[b.dst];
      if (dev) this.identities.set(b.dst, { vendor: dev.vendor, product: dev.product, revision: dev.revision });
    }
  }

  private addToBaseline(l: LinkObs, fcs: number[], how: BaselineLink["how"], anyFc = false, t?: number): BaselineLink {
    let b = this.baseline.find((x) => x.src === l.src && x.dst === l.dst && x.service === l.service);
    if (!b) {
      b = { id: this.nextId++, src: l.src, dst: l.dst, service: l.service, fcs: [], how, ...(t !== undefined ? { t } : {}) };
      this.baseline.push(b);
    }
    if (b.service !== "modbus") return b;
    if (anyFc) b.anyFc = true;
    b.fcs = [...new Set([...b.fcs, ...fcs])].sort((a, c) => a - c);
    return b;
  }

  learned(src: string, dst: string, service: string): BaselineLink | undefined {
    return this.baseline.find((x) => x.src === src && x.dst === dst && x.service === service);
  }

  /** Does the baseline cover this link (and function code)? */
  covers(l: LinkObs): boolean {
    const b = this.learned(l.src, l.dst, l.service);
    if (!b) return false;
    return l.service !== "modbus" || l.fc === undefined || !!b.anyFc || b.fcs.includes(l.fc);
  }

  /** Learn links: from learning mode, or from an alert someone accepted as normal. */
  learn(links: LinkObs[], how: "learning" | "alert", t: number): void {
    for (const l of links) this.addToBaseline(l, l.fc !== undefined ? [l.fc] : [], how, false, t);
  }

  forget(id: number): BaselineLink | undefined {
    const i = this.baseline.findIndex((b) => b.id === id);
    if (i < 0) return undefined;
    return this.baseline.splice(i, 1)[0];
  }

  /** A packet the firewall let through. Returns what in it is new. */
  observe(t: number, src: Host, dst: Host, service: ServiceName, fc: number | undefined, answered: boolean): Anomaly[] {
    const key = linkKey(src.name, dst.name, service);
    let s = this.seen.get(key);
    if (!s) {
      s = { src: src.name, dst: dst.name, service, fcs: [], packets: 0, answered: 0, writes: 0, firstT: t, lastT: t };
      this.seen.set(key, s);
    }
    s.packets++;
    if (answered) s.answered++;
    s.lastT = t;
    if (fc !== undefined) {
      if (!s.fcs.includes(fc)) s.fcs = [...s.fcs, fc].sort((a, b) => a - b);
      if (WRITE_FCS.includes(fc)) s.writes++;
    }
    const link: LinkObs = { src: src.name, dst: dst.name, service, ...(service === "modbus" && fc !== undefined ? { fc } : {}) };
    if (this.covers(link)) return [];
    if (this.mode === "learning") {
      this.learn([link], "learning", t);
      return [];
    }
    return [{ kind: this.learned(src.name, dst.name, service) ? "new-fc" : "new-link", link }];
  }

  /** A device identification reply the sensor saw on the wire. */
  identify(t: number, dst: string, id: { vendor: string; product: string; revision: string }): void {
    const known = this.identities.get(dst);
    if (known && known.vendor === id.vendor && known.product === id.product && known.revision === id.revision) return;
    this.identities.set(dst, { ...id, t });
  }

  /** Links seen since the simulation started, with whether each is in the baseline. */
  links(): (SeenLink & { learned: boolean; newFcs: number[] })[] {
    return [...this.seen.values()].map((s) => {
      const b = this.learned(s.src, s.dst, s.service);
      const newFcs = b && !b.anyFc ? s.fcs.filter((f) => !b.fcs.includes(f)) : [];
      return { ...s, learned: !!b, newFcs };
    });
  }

  /** The asset inventory: every host in the baseline or in traffic. */
  assets(hosts: Host[]): Asset[] {
    const names = new Set<string>();
    for (const b of this.baseline) names.add(b.src).add(b.dst);
    for (const s of this.seen.values()) names.add(s.src).add(s.dst);
    const out: Asset[] = [];
    for (const h of hosts) {
      if (!names.has(h.name)) continue;
      const touches = (l: { src: string; dst: string }) => l.src === h.name || l.dst === h.name;
      const seen = [...this.seen.values()].filter(touches);
      // Probes to ports nobody answers on are traffic, but not services the host offers.
      const all = [...this.baseline.filter(touches).map((b) => ({ src: b.src, dst: b.dst, service: b.service })), ...seen.filter((x) => x.answered > 0)];
      const serves = [...new Set(all.filter((l) => l.dst === h.name).map((l) => l.service))].sort();
      const uses = [...new Set(all.filter((l) => l.src === h.name).map((l) => l.service))].sort();
      const peers = [...new Set([...all, ...seen].map((l) => (l.src === h.name ? l.dst : l.src)).filter((n) => n !== h.name))].sort();
      const device = !!this.site.devices[h.name];
      const type = this.site.ids.safety.includes(h.name) ? "safety controller" : (h.role && ROLE_TYPES[h.role]) || (device ? "controller" : KIND_TYPES[h.kind]);
      out.push({
        name: h.name,
        ip: h.ip,
        zone: h.zone,
        type,
        os: device ? undefined : h.os,
        identity: this.identities.get(h.name),
        serves,
        uses,
        peers,
        known: this.baseline.some((b) => b.src === h.name || b.dst === h.name),
        firstT: seen.length ? Math.min(...seen.map((s) => s.firstT)) : undefined,
        lastT: seen.length ? Math.max(...seen.map((s) => s.lastT)) : undefined,
        packets: seen.reduce((n, s) => n + s.packets, 0),
      });
    }
    return out;
  }
}

/** "fc 16 (write multiple registers)" */
export function fcText(fc: number): string {
  return `fc ${fc} (${FC_NAMES[fc] ?? "unknown"})`;
}

export function linkText(l: LinkObs): string {
  return `${l.src} → ${l.dst} ${l.service}${l.fc !== undefined ? ` ${fcText(l.fc)}` : ""}`;
}
