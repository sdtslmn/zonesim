// The plant views: a one-line status strip, and a full panel with a process
// mimic, trends, the plant's data flows, the design checks and alerts.
// Names and limits come from the site, so a custom plant looks like itself.

import type { Sim } from "@zonesim/core";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function statusStrip(sim: Sim): string {
  const p = sim.tank;
  const flows = sim.requiredFlows();
  const ok = flows.filter((f) => f.ok).length;
  const alarms = sim.plant.alarms().filter((a) => a.severity !== "low");
  const open = sim.alerts.filter((a) => !a.acked).length;
  const pill = (cls: string, text: string, title = "") => `<span class="pill ${cls}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`;
  const parts: string[] = [];
  if (p) {
    const k = p.params;
    const t = p.tags;
    parts.push(
      pill(p.overflowing ? "bad" : p.level >= k.highAlarm || p.level <= k.lowAlarm ? "warn" : "ok", `${t.tank ?? "Tank"} ${p.level.toFixed(1)} %`),
      pill(p.pumpRunning ? "ok" : "idle", `${t.pump ?? "Pump"} ${p.pumpRunning ? "running" : "stopped"}${p.autoMode ? "" : " (manual)"}`),
      pill(p.chlorine < k.chlorineLow || p.chlorine > k.chlorineHigh ? "bad" : "ok", `Cl ${p.chlorine.toFixed(2)} mg/L`),
      pill(p.bypassed ? "bad" : p.sisTrip ? "warn" : "ok", p.bypassed ? "SIS bypassed" : p.sisTrip ? "SIS tripped" : "SIS armed"),
    );
  }
  if (sim.site.hmi) parts.push(pill(sim.hmiOnline ? "ok" : "bad", sim.hmiOnline ? "HMI online" : "HMI comm fail"));
  parts.push(
    pill(ok === flows.length ? "ok" : "bad", `Flows ${ok}/${flows.length}`, flows.filter((f) => !f.ok).map((f) => f.flow.title).join("\n")),
    pill(alarms.length ? "bad" : "ok", alarms.length ? `${alarms.length} alarm${alarms.length === 1 ? "" : "s"}` : "No alarms", alarms.map((a) => a.text).join("\n")),
    pill(open ? "warn" : "ok", `${open} open alert${open === 1 ? "" : "s"}`),
  );
  return `<div class="strip">${parts.join("")}</div>`;
}

function mimic(sim: Sim): string {
  const p = sim.tank!;
  const t = p.tags;
  const sis = sim.roleHost("sis")?.name ?? sim.site.ids.safety[0] ?? "SIS";
  const tx = 150;
  const ty = 30;
  const tw = 110;
  const th = 150;
  const fillH = (th * Math.min(p.level, 100)) / 100;
  const mark = (tenths: number, label: string, cls: string) => {
    const y = ty + th - (th * Math.min(Math.max(tenths, 0), 1000)) / 1000;
    return `<line x1="${tx + tw}" y1="${y}" x2="${tx + tw + 10}" y2="${y}" class="mark ${cls}"/><text x="${tx + tw + 14}" y="${y + 4}" class="mark-label ${cls}">${label} ${tenths / 10} %</text>`;
  };
  const pump = (x: number, y: number, on: boolean, name: string) => `<g class="pump ${on ? "on" : "off"}"><circle cx="${x}" cy="${y}" r="14"/><path d="M${x - 6} ${y - 8} L${x + 9} ${y} L${x - 6} ${y + 8} Z"/><text x="${x}" y="${y + 29}" text-anchor="middle" class="label">${esc(name)}</text></g>`;
  return `<svg class="mimic" viewBox="0 0 470 240" width="100%">
    <text x="10" y="40" class="label">${p.autoMode ? "AUTO" : "MANUAL"}</text>
    <text x="10" y="100" class="label">${esc(t.source ?? "source")}</text>
    <path d="M10 110 H56" class="pipe${p.pumpRunning ? " flow" : ""}"/>
    ${pump(70, 110, p.pumpRunning, t.pump ?? "pump")}
    <path d="M84 110 H${tx}" class="pipe${p.pumpRunning ? " flow" : ""}"/>
    ${pump(70, 168, p.dosingRunning, t.dosing ?? "dosing")}
    <path d="M84 168 H136 V160 H${tx}" class="pipe dose${p.dosingRunning ? " flow" : ""}"/>
    <rect x="${tx}" y="${ty}" width="${tw}" height="${th}" class="tank"/>
    <rect x="${tx + 1}" y="${ty + th - fillH}" width="${tw - 2}" height="${fillH}" class="water${p.overflowing ? " spill" : ""}"/>
    <text x="${tx + tw / 2}" y="${ty + th / 2}" text-anchor="middle" class="big">${p.level.toFixed(1)} %</text>
    <text x="${tx + tw / 2}" y="${ty - 8}" text-anchor="middle" class="label">${esc(t.tank ?? "tank")}</text>
    ${mark(p.tripSp, "trip", "trip")}${mark(p.stopSp, "stop", "sp")}${mark(p.startSp, "start", "sp")}
    <path d="M${tx + tw / 2} ${ty + th} V${ty + th + 20} H460" class="pipe flow"/>
    <text x="400" y="${ty + th + 14}" class="label">${esc(t.consumer ?? "consumers")}</text>
    <g transform="translate(410,40)" class="shield ${p.bypassed ? "bad" : p.sisTrip ? "warn" : "ok"}"><path d="M0 0 L22 6 V22 C22 34 12 42 0 46 C-12 42 -22 34 -22 22 V6 Z"/><text x="0" y="62" text-anchor="middle" class="label">${esc(sis)}</text><text x="0" y="76" text-anchor="middle" class="label">${p.bypassed ? "BYPASSED" : p.sisTrip ? "TRIPPED" : "armed"}</text></g>
    <text x="10" y="234" class="label">Chlorine ${p.chlorine.toFixed(2)} mg/L, setpoint ${(p.chlorineSp / 100).toFixed(2)} mg/L, dosing ${p.dosingRunning ? "on" : "off"}</text>
  </svg>`;
}

function spark(values: number[], max: number, cls: string): string {
  if (values.length < 2) return `<svg class="spark" viewBox="0 0 200 40" width="100%"><text x="4" y="24" class="label">collecting…</text></svg>`;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * 200).toFixed(1)},${(38 - (Math.min(v, max) / max) * 36).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 200 40" width="100%" preserveAspectRatio="none"><polyline points="${pts}" class="${cls}"/></svg>`;
}

export function plantPanel(sim: Sim): string {
  const flows = sim.requiredFlows();
  const risks = sim.risks();
  const alarms = sim.plant.alarms();
  const trend = sim.trend.slice(-120);
  const open = sim.alerts.filter((a) => !a.acked).slice(-8).reverse();
  const process = sim.tank
    ? `${mimic(sim)}
  <div class="trends">
    <div><span class="meta">Level, last ${Math.max(1, Math.round((trend.length * 5) / 60))} min</span>${spark(trend.map((t) => t.level), 100, "lvl")}</div>
    <div><span class="meta">Chlorine residual</span>${spark(trend.map((t) => t.chlorine), 5, "cl")}</div>
  </div>`
    : `<p class="meta">There is no picture for the ${esc(sim.plant.model)} process yet. <code>plant</code> in the terminal shows its values.</p>`;
  return `<h2>${esc(sim.site.name)}</h2>
  <h3>Process</h3>
  ${process}
  ${alarms.length ? `<ul class="alarms">${alarms.map((a) => `<li class="sev-${a.severity}">${esc(a.text)}</li>`).join("")}</ul>` : `<p class="meta">No process alarms.</p>`}
  <h3>Plant data flows (${flows.filter((f) => f.ok).length}/${flows.length})</h3>
  <ul class="results">${flows.map((f) => `<li class="${f.ok ? "ok" : "bad"}">${esc(f.flow.title)}${f.ok ? "" : `<span class="detail">${esc(f.reason)}</span>`}</li>`).join("")}</ul>
  <h3>Security checks (${risks.filter((r) => r.ok).length}/${risks.length})</h3>
  <ul class="results">${risks.map((r) => `<li class="${r.ok ? "ok" : "bad"}">${esc(r.title)}<span class="detail">${esc(r.detail)}</span></li>`).join("")}</ul>
  <h3>Open alerts</h3>
  ${open.length ? `<ul class="alert-list">${open.map((a) => `<li class="sev-${a.severity}"><code>${esc(a.id)}</code> ${esc(a.title)}${a.src ? ` <span class="meta">from ${esc(a.src)}</span>` : ""}</li>`).join("")}</ul><p class="meta">Details in the terminal: <code>alerts show ID</code></p>` : `<p class="meta">No open alerts.</p>`}`;
}
