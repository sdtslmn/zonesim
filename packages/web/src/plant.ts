// The plant views: a one-line status strip, and a full panel with a process
// mimic, trends, the plant's data flows, the design checks and alerts.

import type { Sim } from "@zonesim/core";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function statusStrip(sim: Sim): string {
  const p = sim.plant;
  const flows = sim.requiredFlows();
  const ok = flows.filter((f) => f.ok).length;
  const alarms = p.alarms().filter((a) => a.severity !== "low");
  const open = sim.alerts.filter((a) => !a.acked).length;
  const pill = (cls: string, text: string, title = "") => `<span class="pill ${cls}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`;
  return `<div class="strip">
    ${pill(p.overflowing ? "bad" : p.level >= 85 || p.level <= 20 ? "warn" : "ok", `Tank ${p.level.toFixed(1)} %`)}
    ${pill(p.pumpRunning ? "ok" : "idle", `P-101 ${p.pumpRunning ? "running" : "stopped"}${p.autoMode ? "" : " (manual)"}`)}
    ${pill(p.chlorine < 0.5 || p.chlorine > 4 ? "bad" : "ok", `Cl ${p.chlorine.toFixed(2)} mg/L`)}
    ${pill(p.bypassed ? "bad" : p.sisTrip ? "warn" : "ok", p.bypassed ? "SIS bypassed" : p.sisTrip ? "SIS tripped" : "SIS armed")}
    ${pill(sim.hmiOnline ? "ok" : "bad", sim.hmiOnline ? "HMI online" : "HMI comm fail")}
    ${pill(ok === flows.length ? "ok" : "bad", `Flows ${ok}/${flows.length}`, flows.filter((f) => !f.ok).map((f) => f.flow.title).join("\n"))}
    ${pill(alarms.length ? "bad" : "ok", alarms.length ? `${alarms.length} alarm${alarms.length === 1 ? "" : "s"}` : "No alarms", alarms.map((a) => a.text).join("\n"))}
    ${pill(open ? "warn" : "ok", `${open} open alert${open === 1 ? "" : "s"}`)}
  </div>`;
}

function mimic(sim: Sim): string {
  const p = sim.plant;
  const tx = 150;
  const ty = 30;
  const tw = 110;
  const th = 150;
  const fillH = (th * p.level) / 100;
  const mark = (tenths: number, label: string, cls: string) => {
    const y = ty + th - (th * Math.min(tenths, 1000)) / 1000;
    return `<line x1="${tx + tw}" y1="${y}" x2="${tx + tw + 10}" y2="${y}" class="mark ${cls}"/><text x="${tx + tw + 14}" y="${y + 4}" class="mark-label ${cls}">${label} ${tenths / 10} %</text>`;
  };
  const pump = (x: number, y: number, on: boolean, name: string) => `<g class="pump ${on ? "on" : "off"}"><circle cx="${x}" cy="${y}" r="14"/><path d="M${x - 6} ${y - 8} L${x + 9} ${y} L${x - 6} ${y + 8} Z"/><text x="${x}" y="${y + 29}" text-anchor="middle" class="label">${name}</text></g>`;
  return `<svg class="mimic" viewBox="0 0 470 240" width="100%">
    <text x="10" y="40" class="label">${p.autoMode ? "AUTO" : "MANUAL"}</text>
    <text x="10" y="100" class="label">river</text>
    <path d="M10 110 H56" class="pipe${p.pumpRunning ? " flow" : ""}"/>
    ${pump(70, 110, p.pumpRunning, "P-101")}
    <path d="M84 110 H${tx}" class="pipe${p.pumpRunning ? " flow" : ""}"/>
    ${pump(70, 168, p.dosingRunning, "P-201")}
    <path d="M84 168 H136 V160 H${tx}" class="pipe dose${p.dosingRunning ? " flow" : ""}"/>
    <rect x="${tx}" y="${ty}" width="${tw}" height="${th}" class="tank"/>
    <rect x="${tx + 1}" y="${ty + th - fillH}" width="${tw - 2}" height="${fillH}" class="water${p.overflowing ? " spill" : ""}"/>
    <text x="${tx + tw / 2}" y="${ty + th / 2}" text-anchor="middle" class="big">${p.level.toFixed(1)} %</text>
    <text x="${tx + tw / 2}" y="${ty - 8}" text-anchor="middle" class="label">T-101</text>
    ${mark(p.sisHr[0], "trip", "trip")}${mark(p.plcHr[1], "stop", "sp")}${mark(p.plcHr[0], "start", "sp")}
    <path d="M${tx + tw / 2} ${ty + th} V${ty + th + 20} H460" class="pipe flow"/>
    <text x="420" y="${ty + th + 14}" class="label">town</text>
    <g transform="translate(410,40)" class="shield ${p.bypassed ? "bad" : p.sisTrip ? "warn" : "ok"}"><path d="M0 0 L22 6 V22 C22 34 12 42 0 46 C-12 42 -22 34 -22 22 V6 Z"/><text x="0" y="62" text-anchor="middle" class="label">sis-1</text><text x="0" y="76" text-anchor="middle" class="label">${p.bypassed ? "BYPASSED" : p.sisTrip ? "TRIPPED" : "armed"}</text></g>
    <text x="10" y="234" class="label">Chlorine ${p.chlorine.toFixed(2)} mg/L, setpoint ${(p.plcHr[2] / 100).toFixed(2)} mg/L, dosing ${p.dosingRunning ? "on" : "off"}</text>
  </svg>`;
}

function spark(values: number[], max: number, cls: string): string {
  if (values.length < 2) return `<svg class="spark" viewBox="0 0 200 40" width="100%"><text x="4" y="24" class="label">collecting…</text></svg>`;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * 200).toFixed(1)},${(38 - (Math.min(v, max) / max) * 36).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 200 40" width="100%" preserveAspectRatio="none"><polyline points="${pts}" class="${cls}"/></svg>`;
}

export function plantPanel(sim: Sim): string {
  const p = sim.plant;
  const flows = sim.requiredFlows();
  const risks = sim.risks();
  const alarms = p.alarms();
  const trend = sim.trend.slice(-120);
  const open = sim.alerts.filter((a) => !a.acked).slice(-8).reverse();
  return `${statusStrip(sim)}
  <h3>Process</h3>
  ${mimic(sim)}
  <div class="trends">
    <div><span class="meta">Tank level, last ${Math.max(1, Math.round((trend.length * 5) / 60))} min</span>${spark(trend.map((t) => t.level), 100, "lvl")}</div>
    <div><span class="meta">Chlorine residual</span>${spark(trend.map((t) => t.chlorine), 5, "cl")}</div>
  </div>
  ${alarms.length ? `<ul class="alarms">${alarms.map((a) => `<li class="sev-${a.severity}">${esc(a.text)}</li>`).join("")}</ul>` : `<p class="meta">No process alarms.</p>`}
  <h3>Plant data flows (${flows.filter((f) => f.ok).length}/${flows.length})</h3>
  <ul class="results">${flows.map((f) => `<li class="${f.ok ? "ok" : "bad"}">${esc(f.flow.title)}${f.ok ? "" : `<span class="detail">${esc(f.reason)}</span>`}</li>`).join("")}</ul>
  <h3>Security checks (${risks.filter((r) => r.ok).length}/${risks.length})</h3>
  <ul class="results">${risks.map((r) => `<li class="${r.ok ? "ok" : "bad"}">${esc(r.title)}<span class="detail">${esc(r.detail)}</span></li>`).join("")}</ul>
  <h3>Open alerts</h3>
  ${open.length ? `<ul class="alert-list">${open.map((a) => `<li class="sev-${a.severity}"><code>${esc(a.id)}</code> ${esc(a.title)}${a.src ? ` <span class="meta">from ${esc(a.src)}</span>` : ""}</li>`).join("")}</ul><p class="meta">Details in the terminal: <code>alerts show ID</code></p>` : `<p class="meta">No open alerts.</p>`}`;
}
