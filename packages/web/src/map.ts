// The network map: Purdue levels as horizontal bands, zones as boxes around
// their hosts, conduits as lines with a firewall in the middle, and every
// request animated as a dot (green when it gets through, red where it is
// stopped). It reads the simulation and never changes it.

import { LEVEL_NAMES, SERVICES, type Sim, type TrafficEvent, type Host } from "@zonesim/core";

const BANDS = [5, 4, 3.5, 3, 2, 1];
const BAND_H = 86;
const CHIP_W = 112;
const CHIP_H = 34;
const GAP = 10;
const PAD = 10;
const LABEL_W = 104;
const TOP = 8;

type Box = { x: number; y: number; w: number; h: number };

interface Flight {
  pts: [number, number][];
  ok: boolean;
  plant: boolean;
  label?: string;
  start: number;
  dur: number;
  el?: SVGGElement;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export class NetworkMap {
  showPlantTraffic = true;
  selected?: string;
  private el?: HTMLElement;
  private chips = new Map<string, Box>();
  private zoneBoxes = new Map<string, Box>();
  /** Conduit geometry: points from the first zone's side to the second's, and the firewall position. */
  private conduitGeo = new Map<string, { zones: [string, string]; pts: [number, number][]; mid: [number, number] }>();
  private lastSeq = 0;
  private signature = "";
  private flights: Flight[] = [];
  private raf = 0;
  private simRef?: Sim;

  constructor(private getSim: () => Sim) {}

  get mounted(): boolean {
    return !!this.el?.isConnected;
  }

  mount(el: HTMLElement): void {
    this.el = el;
    this.signature = "";
    this.flights = [];
    el.innerHTML = `<div class="map">
      <div class="map-head">
        <label class="meta"><input type="checkbox" id="map-plant"${this.showPlantTraffic ? " checked" : ""}> plant traffic</label>
        <span class="meta">Dots: <span class="ok-text">green</span> got through, <span class="bad-text">red</span> was stopped.</span>
      </div>
      <div id="map-svg"></div>
      <div id="map-detail"></div>
    </div>`;
    el.querySelector<HTMLInputElement>("#map-plant")!.addEventListener("change", (e) => {
      this.showPlantTraffic = (e.target as HTMLInputElement).checked;
    });
    this.refresh();
  }

  unmount(): void {
    this.el = undefined;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  refresh(): void {
    if (!this.el?.isConnected) return;
    const sim = this.getSim();
    if (sim !== this.simRef) {
      this.simRef = sim;
      this.lastSeq = sim.events.at(-1)?.seq ?? 0;
      this.selected = undefined;
      this.signature = "";
      this.flights = [];
    }
    const alerting = [...new Set(sim.alerts.filter((a) => !a.acked && a.source === "ids" && a.src).map((a) => a.src!))].sort();
    const sig = JSON.stringify([sim.net.hosts.map((h) => [h.name, h.zone, h.mfa, h.link]), sim.net.zones, sim.net.conduits.map((c) => [c.name, c.zones, c.rules.length]), this.selected, alerting]);
    if (sig !== this.signature) {
      this.signature = sig;
      const holder = this.el.querySelector<HTMLElement>("#map-svg")!;
      holder.innerHTML = this.svg(sim, alerting);
      holder.querySelectorAll<SVGGElement>("[data-host]").forEach((g) =>
        g.addEventListener("click", () => {
          const h = g.dataset.host!;
          this.selected = this.selected === h ? undefined : h;
          this.refresh();
        }),
      );
      this.flights = this.flights.filter((f) => f.el?.isConnected);
    }
    this.renderDetail(sim);
    this.animate(sim);
  }

  // ---------------------------------------------------------------- layout

  private svg(sim: Sim, alerting: string[]): string {
    this.chips.clear();
    this.zoneBoxes.clear();
    this.conduitGeo.clear();
    const net = sim.net;
    const band = (h: Host) => Math.max(0, BANDS.indexOf(h.level));

    type Placed = { name: string; box: Box; top: number; bottom: number };
    const placed: Placed[] = [];
    const zones = net.zones
      .map((z) => ({ z, hosts: net.hostsIn(z.name) }))
      .filter((x) => x.hosts.length)
      .map((x) => {
        const bands = x.hosts.map(band);
        const top = Math.min(...bands);
        const bottom = Math.max(...bands);
        const perBand = new Map<number, Host[]>();
        for (const h of x.hosts) perBand.set(band(h), [...(perBand.get(band(h)) ?? []), h]);
        const cols = Math.max(...[...perBand.values()].map((l) => l.length));
        const label = `${x.z.name}${x.z.sl ? ` · SL-T ${x.z.sl}` : ""}${carrier(x.z)}`;
        return { ...x, top, bottom, perBand, w: Math.max(PAD * 2 + cols * CHIP_W + (cols - 1) * GAP, 18 + label.length * 6.9) };
      })
      .sort((a, b) => a.top - b.top || a.z.name.localeCompare(b.z.name));

    // Room between side-by-side zones: enough for a conduit label if they are connected.
    const gapBetween = (a: string, b: string) => {
      const c = net.conduitBetween(a, b);
      return c ? Math.max(30, 26 + `${c.name} (99)`.length * 6.9) : 30;
    };
    for (const z of zones) {
      let x = LABEL_W + 10;
      for (;;) {
        const clash = placed.find((p) => !(z.bottom < p.top || z.top > p.bottom) && x < p.box.x + p.box.w + gapBetween(p.name, z.z.name) && x + z.w + 22 > p.box.x);
        if (!clash) break;
        x = clash.box.x + clash.box.w + gapBetween(clash.name, z.z.name);
      }
      const box: Box = { x, y: TOP + z.top * BAND_H + 8, w: z.w, h: (z.bottom - z.top + 1) * BAND_H - 20 };
      placed.push({ name: z.z.name, box, top: z.top, bottom: z.bottom });
      this.zoneBoxes.set(z.z.name, box);
      for (const [b, list] of z.perBand) {
        list.sort((p, q) => p.name.localeCompare(q.name)).forEach((h, i) => this.chips.set(h.name, { x: box.x + PAD + i * (CHIP_W + GAP), y: TOP + b * BAND_H + 30, w: CHIP_W, h: CHIP_H }));
      }
    }

    const empty = net.zones.filter((z) => !net.hostsIn(z.name).length);
    const width = Math.max(560, ...placed.map((p) => p.box.x + p.box.w + 16));
    const bandsBottom = TOP + BANDS.length * BAND_H;
    const height = bandsBottom + (empty.length ? 46 : 6);

    const parts: string[] = [];
    BANDS.forEach((lvl, i) => {
      const y = TOP + i * BAND_H;
      parts.push(`<rect class="band${i % 2 ? " alt" : ""}" x="0" y="${y}" width="__W__" height="${BAND_H}"/>`);
      parts.push(`<text class="band-label" x="8" y="${y + 20}">L${lvl}</text><text class="band-name" x="8" y="${y + 34}">${esc(LEVEL_NAMES[String(lvl)] ?? "")}</text>`);
    });

    // Zones
    for (const p of placed) {
      const z = net.zone(p.name)!;
      parts.push(`<g class="zone"><rect x="${p.box.x}" y="${p.box.y}" width="${p.box.w}" height="${p.box.h}" rx="8"/><text x="${p.box.x + 8}" y="${p.box.y + 15}" class="zone-name">${esc(z.name)}${z.sl ? ` · SL-T ${z.sl}` : ""}<tspan class="zone-carrier">${esc(carrier(z))}</tspan></text></g>`);
    }

    // Conduits. A conduit between two zones with another zone in the way is
    // routed around the right-hand side, in its own lane.
    const conduitParts: string[] = [];
    const boxes = [...this.zoneBoxes.entries()];
    const rightEdge = Math.max(0, ...boxes.map(([, b]) => b.x + b.w));
    let lanes = 0;
    let maxX = width;
    for (const c of net.conduits) {
      const a = this.zoneBoxes.get(c.zones[0]);
      const b = this.zoneBoxes.get(c.zones[1]);
      if (!a || !b) continue;
      const [p1, p2, vertical] = anchors(a, b);
      const minX = Math.min(p1[0], p2[0]) - 4;
      const maxXp = Math.max(p1[0], p2[0]) + 4;
      const minY = Math.min(p1[1], p2[1]) + 1;
      const maxY = Math.max(p1[1], p2[1]) - 1;
      const blocked = boxes.some(([n, bx]) => n !== c.zones[0] && n !== c.zones[1] && bx.x < maxXp && bx.x + bx.w > minX && bx.y < maxY && bx.y + bx.h > minY);
      let d: string;
      let pts: [number, number][];
      let mid: [number, number];
      let labelBeside = true;
      if (blocked) {
        const lane = rightEdge + 22 + lanes++ * 22;
        const y1 = a.y + Math.min(a.h / 2, 30);
        const y2 = b.y + Math.min(b.h / 2, 30);
        const s1: [number, number] = [a.x + a.w, y1];
        const s2: [number, number] = [b.x + b.w, y2];
        pts = [s1, [lane, y1], [lane, y2], s2];
        mid = [lane, (y1 + y2) / 2];
        d = `M${s1[0]} ${y1} H${lane - 6} Q${lane} ${y1} ${lane} ${y1 + Math.sign(y2 - y1) * 6} V${y2 - Math.sign(y2 - y1) * 6} Q${lane} ${y2} ${lane - 6} ${y2} H${s2[0]}`;
      } else {
        mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
        pts = [p1, mid, p2];
        labelBeside = vertical;
        d = vertical ? `M${p1[0]} ${p1[1]} C${p1[0]} ${mid[1]} ${p2[0]} ${mid[1]} ${p2[0]} ${p2[1]}` : `M${p1[0]} ${p1[1]} C${mid[0]} ${p1[1]} ${mid[0]} ${p2[1]} ${p2[0]} ${p2[1]}`;
      }
      this.conduitGeo.set(c.name, { zones: [c.zones[0], c.zones[1]], pts, mid });
      const allows = c.rules.filter((r) => r.action === "allow").length;
      const text = `${c.name} (${allows})`;
      const label = labelBeside ? `<text class="conduit-label" x="${mid[0] + 15}" y="${mid[1] + 4}">${esc(text)}</text>` : `<text class="conduit-label" x="${mid[0]}" y="${mid[1] - 11}" text-anchor="middle">${esc(text)}</text>`;
      if (labelBeside) maxX = Math.max(maxX, mid[0] + 22 + text.length * 7);
      conduitParts.push(`<g class="conduit"><path d="${d}"/><g transform="translate(${mid[0] - 11},${mid[1] - 7})"><rect class="fw" width="22" height="14" rx="2"/><path class="brick" d="M0 7h22M7 0v7M15 7v7"/></g>${label}<title>${esc(`conduit ${c.name}: ${c.zones[0]} ↔ ${c.zones[1]}\n${c.rules.length} rule${c.rules.length === 1 ? "" : "s"}, then deny everything else`)}</title></g>`);
    }
    const fullWidth = Math.max(width, maxX + 8);

    // Hosts
    const hostParts: string[] = [];
    for (const h of net.hosts) {
      const b = this.chips.get(h.name);
      if (!b) continue;
      const cls = `host k-${h.kind}${this.selected === h.name ? " sel" : ""}${alerting.includes(h.name) ? " alerting" : ""}${h.link ? "" : " down"}`;
      const lock = h.mfa ? `<text x="${b.x + b.w - 28}" y="${b.y + 14}" class="mfa">MFA</text>` : "";
      hostParts.push(`<g class="${cls}" data-host="${esc(h.name)}"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6"/><text x="${b.x + 8}" y="${b.y + 14}" class="host-name">${esc(h.name)}</text><text x="${b.x + 8}" y="${b.y + 27}" class="host-ip">${esc(h.ip)}</text>${lock}<title>${esc(`${h.name} (${h.ip})\n${h.description}\nservices: ${h.services.join(", ") || "none"}${h.port ? `\nswitch port: ${h.port.device} ${h.port.port}` : ""}${h.link ? "" : `\nlink down: ${h.linkReason ?? ""}`}`)}</title></g>`);
    }

    if (empty.length) {
      parts.push(`<text class="band-name" x="8" y="${bandsBottom + 28}">empty zones</text>`);
      let x = LABEL_W + 10;
      for (const z of empty) {
        const w = 14 + z.name.length * 7.2;
        parts.push(`<g class="zone empty"><rect x="${x}" y="${bandsBottom + 10}" width="${w}" height="28" rx="6"/><text x="${x + 7}" y="${bandsBottom + 28}" class="zone-name">${esc(z.name)}</text></g>`);
        x += w + 10;
      }
    }

    const bands = parts.join("").replace(/width="__W__"/g, `width="${fullWidth}"`);
    return `<svg class="netmap" viewBox="0 0 ${fullWidth} ${height}" style="width:100%;max-width:${fullWidth}px" role="img" aria-label="Network map">${bands}<g>${conduitParts.join("")}</g><g>${hostParts.join("")}</g><g id="traffic"></g></svg>`;
  }

  // ---------------------------------------------------------------- details

  private renderDetail(sim: Sim): void {
    const box = this.el?.querySelector<HTMLElement>("#map-detail");
    if (!box) return;
    const h = this.selected ? sim.net.host(this.selected) : undefined;
    if (!h) {
      const html = `<p class="meta">Click a host for details. Zones are the boxes, conduits the lines between them; the number is how many allow rules a conduit has.</p>`;
      if (box.innerHTML !== html) box.innerHTML = html;
      return;
    }
    const convs = [...sim.conversations.values()].filter((c) => c.src === h.name || c.dst === h.name).sort((a, b) => b.lastT - a.lastT).slice(0, 8);
    const rows = convs.map((c) => `<tr><td>${esc(c.src)} → ${esc(c.dst)}</td><td>${esc(c.service)}${c.fcs.length ? ` fc ${c.fcs.join(",")}` : ""}</td><td>${c.background ? "plant" : "you"}</td><td class="${c.lastOk ? "ok-text" : "bad-text"}">${c.lastOk ? "ok" : "blocked"}</td></tr>`).join("");
    const services = h.services.map((s) => `${s} (${SERVICES[s].label})`).join(", ") || "none";
    const shell = h.kind === "ot" && h.level <= 1 ? `Controllers have no shell: talk to it with <code>modbus</code> from a host.` : `Run commands from it: <code>ssh ${esc(h.name)}</code>`;
    const html = `<div class="host-detail"><strong>${esc(h.name)}</strong> <span class="meta">${esc(h.ip)} · L${h.level} ${esc(LEVEL_NAMES[String(h.level)] ?? "")} · zone ${esc(h.zone)}${h.port ? ` · ${esc(h.port.device)} port ${esc(h.port.port)}` : ""}</span>${h.link ? "" : `<div class="bad-text">Link down: ${esc(h.linkReason ?? "")}</div>`}
      <div>${esc(h.description)}. ${esc(h.os)}.${h.role ? ` <span class="meta">Role: ${esc(h.role)}</span>` : ""}</div>
      <div class="meta">Services: ${esc(services)}${h.services.includes("rdp") || h.services.includes("ssh") ? ` · MFA ${h.mfa ? "on" : "off"}` : ""}</div>
      <div class="meta">${shell}</div>
      ${rows ? `<table class="conv"><tr><th>Conversation</th><th>Service</th><th>By</th><th>Last</th></tr>${rows}</table>` : `<p class="meta">No traffic seen yet.</p>`}
    </div>`;
    if (box.innerHTML !== html) box.innerHTML = html;
  }

  // ---------------------------------------------------------------- traffic

  private animate(sim: Sim): void {
    const fresh = sim.events.filter((e) => e.seq > this.lastSeq);
    if (fresh.length) {
      this.lastSeq = fresh.at(-1)!.seq;
      const mine = fresh.filter((e) => !e.background).slice(-10);
      const plant = this.showPlantTraffic ? fresh.filter((e) => e.background).slice(-6) : [];
      for (const e of [...plant, ...mine]) this.addFlight(sim, e);
    }
    if (this.flights.length && !this.raf) this.raf = requestAnimationFrame(() => this.frame());
  }

  private addFlight(sim: Sim, e: TrafficEvent): void {
    const a = this.chips.get(e.src);
    const b = this.chips.get(e.dst);
    if (!a || !b) return;
    const pa: [number, number] = [a.x + a.w / 2, a.y + a.h / 2];
    const pb: [number, number] = [b.x + b.w / 2, b.y + b.h / 2];
    const src = sim.net.host(e.src)!;
    const dst = sim.net.host(e.dst)!;
    const cross = src.zone !== dst.zone;
    const geo = cross && e.conduit ? this.conduitGeo.get(e.conduit) : undefined;
    let pts: [number, number][];
    if (geo) {
      const path = geo.zones[0] === src.zone ? geo.pts : [...geo.pts].reverse();
      if (e.allowed) pts = [pa, ...path, pb];
      else {
        // Up to the firewall in the middle of the conduit.
        const half: [number, number][] = [];
        for (const pt of path) {
          half.push(pt);
          if (pt[0] === geo.mid[0] && pt[1] === geo.mid[1]) break;
        }
        if (half[half.length - 1] !== geo.mid) {
          // Lane conduits have no point at the middle: stop on the lane.
          half.splice(2);
          half.push(geo.mid);
        }
        pts = [pa, ...half];
      }
    } else if (e.allowed) pts = [pa, pb];
    else pts = [pa, [pa[0] + (pb[0] - pa[0]) * 0.3, pa[1] + (pb[1] - pa[1]) * 0.3]];
    let label: string | undefined;
    if (!e.allowed) {
      label = e.reason.startsWith("no conduit") ? "✕ no conduit" : e.reason.includes("function code") ? `✕ fc ${e.fc} filtered` : "✕ blocked";
    } else if (!e.delivered) label = "✕ refused";
    this.flights.push({ pts, ok: e.delivered, plant: e.background, label, start: performance.now(), dur: e.background ? 900 : 1200 });
    if (this.flights.length > 40) this.flights.splice(0, this.flights.length - 40);
  }

  private frame(): void {
    this.raf = 0;
    const layer = this.el?.querySelector<SVGGElement>("#traffic");
    const now = performance.now();
    this.flights = this.flights.filter((f) => now - f.start < f.dur + (f.ok ? 150 : 1600));
    if (!layer) {
      this.flights = [];
      return;
    }
    const ns = "http://www.w3.org/2000/svg";
    for (const f of this.flights) {
      if (!f.el || !f.el.isConnected) {
        f.el = document.createElementNS(ns, "g");
        f.el.setAttribute("class", `flight ${f.ok ? "ok" : "blocked"}${f.plant ? " plant" : ""}`);
        const dot = document.createElementNS(ns, "circle");
        dot.setAttribute("r", f.plant ? "3" : "5");
        f.el.appendChild(dot);
        layer.appendChild(f.el);
      }
      const k = Math.min(1, (now - f.start) / f.dur);
      const [x, y] = along(f.pts, k);
      const dot = f.el.querySelector("circle")!;
      dot.setAttribute("cx", x.toFixed(1));
      dot.setAttribute("cy", y.toFixed(1));
      if (k === 1 && f.label && !f.plant && !f.el.querySelector("text")) {
        const t = document.createElementNS(ns, "text");
        t.setAttribute("x", (x + 8).toFixed(1));
        t.setAttribute("y", (y - 8).toFixed(1));
        t.setAttribute("class", "blocked-label");
        t.textContent = f.label;
        f.el.appendChild(t);
      }
    }
    for (const el of [...layer.children]) if (!this.flights.some((f) => f.el === el)) el.remove();
    if (this.flights.length) this.raf = requestAnimationFrame(() => this.frame());
  }
}

/** What carries a zone, for its label: a VLAN on the switches or a firewall port. */
function carrier(z: { vlan?: number; port?: string }): string {
  return z.vlan !== undefined ? ` · VLAN ${z.vlan}` : z.port ? ` · ${z.port}` : "";
}

/** Connection points on two boxes, facing each other, and whether the link is vertical. */
function anchors(a: Box, b: Box): [[number, number], [number, number], boolean] {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const acx = a.x + a.w / 2;
  const bcx = b.x + b.w / 2;
  const acy = a.y + a.h / 2;
  const bcy = b.y + b.h / 2;
  // Boxes above each other: a straight vertical line where they overlap.
  const vx = overlapX > 40 ? Math.max(a.x, b.x) + Math.min(overlapX / 2, 70) : undefined;
  if (b.y >= a.y + a.h - 2) return [[vx ?? clamp(bcx, a.x + 16, a.x + a.w - 16), a.y + a.h], [vx ?? clamp(acx, b.x + 16, b.x + b.w - 16), b.y], true];
  if (a.y >= b.y + b.h - 2) return [[vx ?? clamp(bcx, a.x + 16, a.x + a.w - 16), a.y], [vx ?? clamp(acx, b.x + 16, b.x + b.w - 16), b.y + b.h], true];
  // Side by side: a horizontal line at a height both boxes share.
  const top = Math.max(a.y, b.y) + 22;
  const bottom = Math.min(a.y + a.h, b.y + b.h) - 12;
  const y = top <= bottom ? (top + bottom) / 2 : undefined;
  if (b.x >= a.x + a.w) return [[a.x + a.w, y ?? clamp(bcy, a.y + 20, a.y + a.h - 12)], [b.x, y ?? clamp(acy, b.y + 20, b.y + b.h - 12)], false];
  return [[a.x, y ?? clamp(bcy, a.y + 20, a.y + a.h - 12)], [b.x + b.w, y ?? clamp(acy, b.y + 20, b.y + b.h - 12)], false];
}

/** The point at fraction k (0..1) along a polyline. */
function along(pts: [number, number][], k: number): [number, number] {
  if (pts.length === 1) return pts[0];
  const segs = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
  let d = segs.reduce((a, b) => a + b, 0) * k;
  for (let i = 0; i < segs.length; i++) {
    if (d <= segs[i] || i === segs.length - 1) {
      const t = segs[i] ? Math.min(1, d / segs[i]) : 1;
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
    }
    d -= segs[i];
  }
  return pts[pts.length - 1];
}
