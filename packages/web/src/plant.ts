// The plant views: a one-line status strip, and a full panel with a process
// picture, trends, the plant's data flows, the design checks and alerts.
// Values come from the process model's readouts, so every plant fits; each
// built-in process also gets a picture of its own.

import { WaterTank, GasCompressor, DcCooling, type Sim } from "@zonesim/core";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function statusStrip(sim: Sim): string {
  const flows = sim.requiredFlows();
  const ok = flows.filter((f) => f.ok).length;
  const alarms = sim.plant.alarms().filter((a) => a.severity !== "low");
  const open = sim.alerts.filter((a) => !a.acked).length;
  const pill = (cls: string, text: string, title = "") => `<span class="pill ${cls}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`;
  const parts = sim.readouts().filter((r) => r.strip).map((r) => pill(r.state, r.strip!, `${r.label}: ${r.text}${r.note ? ` (${r.note})` : ""}`));
  if (sim.site.hmi) parts.push(pill(sim.hmiOnline ? "ok" : "bad", sim.hmiOnline ? "HMI online" : "HMI comm fail"));
  parts.push(
    pill(ok === flows.length ? "ok" : "bad", `Flows ${ok}/${flows.length}`, flows.filter((f) => !f.ok).map((f) => f.flow.title).join("\n")),
    pill(alarms.length ? "bad" : "ok", alarms.length ? `${alarms.length} alarm${alarms.length === 1 ? "" : "s"}` : "No alarms", alarms.map((a) => a.text).join("\n")),
    pill(open ? "warn" : "ok", `${open} open alert${open === 1 ? "" : "s"}`),
  );
  return `<div class="strip">${parts.join("")}</div>`;
}

const pumpIcon = (x: number, y: number, on: boolean, name: string) =>
  `<g class="pump ${on ? "on" : "off"}"><circle cx="${x}" cy="${y}" r="14"/><path d="M${x - 6} ${y - 8} L${x + 9} ${y} L${x - 6} ${y + 8} Z"/><text x="${x}" y="${y + 29}" text-anchor="middle" class="label">${esc(name)}</text></g>`;

const shield = (x: number, y: number, state: string, name: string, text: string) =>
  `<g transform="translate(${x},${y})" class="shield ${state}"><path d="M0 0 L22 6 V22 C22 34 12 42 0 46 C-12 42 -22 34 -22 22 V6 Z"/><text x="0" y="62" text-anchor="middle" class="label">${esc(name)}</text><text x="0" y="76" text-anchor="middle" class="label">${esc(text)}</text></g>`;

/** A valve as a bow tie: open when filled light, closed when dark. */
const valve = (x: number, y: number, open: boolean, label: string, vertical = false) => {
  const d = vertical ? `M${x - 8} ${y - 10} L${x + 8} ${y - 10} L${x - 8} ${y + 10} L${x + 8} ${y + 10} Z` : `M${x - 10} ${y - 8} L${x - 10} ${y + 8} L${x + 10} ${y - 8} L${x + 10} ${y + 8} Z`;
  return `<g class="valve ${open ? "open" : "closed"}"><path d="${d}"/><text x="${x}" y="${y - 14}" text-anchor="middle" class="label">${esc(label)}</text></g>`;
};

function waterMimic(sim: Sim, p: WaterTank): string {
  const t = p.tags;
  const sis = sim.safetyName ?? "SIS";
  const tx = 150;
  const ty = 30;
  const tw = 110;
  const th = 150;
  const fillH = (th * Math.min(p.level, 100)) / 100;
  const mark = (tenths: number, label: string, cls: string) => {
    const y = ty + th - (th * Math.min(Math.max(tenths, 0), 1000)) / 1000;
    return `<line x1="${tx + tw}" y1="${y}" x2="${tx + tw + 10}" y2="${y}" class="mark ${cls}"/><text x="${tx + tw + 14}" y="${y + 4}" class="mark-label ${cls}">${label} ${tenths / 10} %</text>`;
  };
  return `<svg class="mimic" viewBox="0 0 470 240" width="100%">
    <text x="10" y="40" class="label">${p.autoMode ? "AUTO" : "MANUAL"}</text>
    <text x="10" y="100" class="label">${esc(t.source ?? "source")}</text>
    <path d="M10 110 H56" class="pipe${p.pumpRunning ? " flow" : ""}"/>
    ${pumpIcon(70, 110, p.pumpRunning, t.pump ?? "pump")}
    <path d="M84 110 H${tx}" class="pipe${p.pumpRunning ? " flow" : ""}"/>
    ${pumpIcon(70, 168, p.dosingRunning, t.dosing ?? "dosing")}
    <path d="M84 168 H136 V160 H${tx}" class="pipe dose${p.dosingRunning ? " flow" : ""}"/>
    <rect x="${tx}" y="${ty}" width="${tw}" height="${th}" class="tank"/>
    <rect x="${tx + 1}" y="${ty + th - fillH}" width="${tw - 2}" height="${fillH}" class="water${p.overflowing ? " spill" : ""}"/>
    <text x="${tx + tw / 2}" y="${ty + th / 2}" text-anchor="middle" class="big">${p.level.toFixed(1)} %</text>
    <text x="${tx + tw / 2}" y="${ty - 8}" text-anchor="middle" class="label">${esc(t.tank ?? "tank")}</text>
    ${mark(p.tripSp, "trip", "trip")}${mark(p.stopSp, "stop", "sp")}${mark(p.startSp, "start", "sp")}
    <path d="M${tx + tw / 2} ${ty + th} V${ty + th + 20} H460" class="pipe flow"/>
    <text x="400" y="${ty + th + 14}" class="label">${esc(t.consumer ?? "consumers")}</text>
    ${shield(410, 40, p.bypassed ? "bad" : p.sisTrip ? "warn" : "ok", sis, p.bypassed ? "BYPASSED" : p.sisTrip ? "TRIPPED" : "armed")}
    <text x="10" y="234" class="label">Chlorine ${p.chlorine.toFixed(2)} mg/L, setpoint ${(p.chlorineSp / 100).toFixed(2)} mg/L, dosing ${p.dosingRunning ? "on" : "off"}</text>
  </svg>`;
}

function gasMimic(sim: Sim, g: GasCompressor): string {
  const t = g.tags;
  const p = g.params;
  const sis = sim.safetyName ?? "ESD";
  const flowing = g.flow > 0.001;
  const recycling = g.recycle > 0.5 && g.running;
  const kState = g.surging ? "bad" : g.running ? "on" : "off";
  const meter = sim.devices.size ? g.get("meter.flow") : 0;
  return `<svg class="mimic" viewBox="0 0 540 268" width="100%">
    <text x="10" y="20" class="label">${g.autoMode ? "AUTO" : "MANUAL"} speed, anti-surge ${g.antisurgeAuto ? "AUTO" : "MANUAL"}</text>
    <text x="10" y="118" class="label">${esc(t.source ?? "upstream")}</text>
    <path d="M10 130 H150" class="pipe gas${g.running ? " flow" : ""}"/>
    <text x="40" y="152" class="label">${p.suctionPressure.toFixed(1)} bar</text>
    <path d="M180 112 V60 H330 V112" class="pipe recycle${recycling ? " flow" : ""}"/>
    ${valve(255, 60, g.recycle > 0.5, `${t.recycle ?? "recycle"} ${g.recycle.toFixed(0)} %`)}
    <g class="machine ${kState}"><path d="M150 108 L210 116 L210 144 L150 152 Z"/><text x="180" y="172" text-anchor="middle" class="label">${esc(t.compressor ?? "compressor")}</text><text x="180" y="186" text-anchor="middle" class="label">${g.running ? `${(g.speed * 100).toFixed(0)} %` : g.vibrationTrip ? "VIB TRIP" : "stopped"}</text></g>
    ${g.surging ? `<text x="180" y="100" text-anchor="middle" class="alarm-text">SURGE</text>` : ""}
    <path d="M210 130 H300" class="pipe gas${g.running ? " flow" : ""}"/>
    <path d="M330 130 V112" class="pipe gas"/>
    <path d="M300 130 H380" class="pipe gas${flowing ? " flow" : ""}"/>
    <path d="M362 130 V96" class="pipe gas"/>
    <g class="psv ${g.venting ? "venting" : ""}"><path d="M354 96 L370 96 L362 84 Z"/><text x="362" y="78" text-anchor="middle" class="label">${esc(t.relief ?? "PSV")}</text>${g.venting ? `<path d="M362 70 C352 56 372 48 362 34" class="vent"/><text x="378" y="46" class="alarm-text">VENTING</text>` : ""}</g>
    ${valve(400, 130, !g.esdClosed, t.esd ?? "ESD valve")}
    <path d="M410 130 H535" class="pipe gas${flowing ? " flow" : ""}"/>
    <rect x="438" y="112" width="44" height="36" rx="4" class="box on"/><text x="460" y="134" text-anchor="middle" class="label">${esc(t.meter ?? "meter")}</text>
    <text x="460" y="166" text-anchor="middle" class="label">${meter} kSm³/h</text>
    <text x="535" y="104" text-anchor="end" class="label">${esc(t.consumer ?? "downstream")}</text>
    <text x="240" y="160" class="big small">${g.pd.toFixed(1)} bar</text>
    <text x="240" y="176" class="label">setpoint ${(g.dischargeSp / 10).toFixed(1)}, trip ${(g.tripSp / 10).toFixed(1)}, relief ${p.reliefPressure}</text>
    ${shield(505, 180, g.bypassed ? "bad" : g.sisTrip ? "warn" : "ok", sis, g.bypassed ? "BYPASSED" : g.sisTrip ? "TRIPPED" : "armed")}
    <text x="10" y="258" class="label">Station flow ${g.get("flow")} kSm³/h, surge margin ${Math.max(0, Math.round(g.margin))} %${g.surgeSeconds > 0 ? `, ${Math.round(g.surgeSeconds)} s of surge so far` : ""}</text>
  </svg>`;
}

function dcMimic(sim: Sim, d: DcCooling): string {
  const t = d.tags;
  const p = d.params;
  const fp = sim.safetyName ?? "fire panel";
  const hot = d.coldAisle > p.allowableMax ? "bad" : d.coldAisle > p.recommendedMax ? "warn" : "ok";
  const chiller = (y: number, name: string, run: boolean, en: boolean) =>
    `<g class="box ${run ? "on" : en ? "standby" : "off"}"><rect x="20" y="${y}" width="86" height="40" rx="4"/><text x="63" y="${y + 18}" text-anchor="middle" class="label">${esc(name)}</text><text x="63" y="${y + 32}" text-anchor="middle" class="label">${run ? "running" : en ? "standby" : "OFF"}</text></g>`;
  const racks = Array.from({ length: 5 }, (_, i) => `<rect x="${350 + i * 22}" y="70" width="16" height="70" rx="2" class="rack ${d.itShutdown || d.released ? "off" : ""}"/>`).join("");
  const water = d.pumpRunning;
  return `<svg class="mimic" viewBox="0 0 540 250" width="100%">
    <text x="10" y="18" class="label">${d.autoMode ? "AUTO, N+1" : "MANUAL"}</text>
    ${chiller(30, t.chiller1 ?? "CH-1", d.running1, d.enable1)}
    ${chiller(90, t.chiller2 ?? "CH-2", d.running2, d.enable2)}
    <path d="M106 50 H140 V75" class="pipe chw${water ? " flow" : ""}"/>
    <path d="M106 110 H140 V75" class="pipe chw${water ? " flow" : ""}"/>
    <path d="M140 75 H186" class="pipe chw${water ? " flow" : ""}"/>
    ${pumpIcon(200, 75, d.pumpRunning, t.pump ?? "pump")}
    <path d="M214 75 H250" class="pipe chw${water ? " flow" : ""}"/>
    <g class="box ${water && !d.released ? "on" : "off"}"><rect x="250" y="55" width="70" height="60" rx="4"/><text x="285" y="80" text-anchor="middle" class="label">${esc(t.crah ?? "CRAH")}</text><text x="285" y="96" text-anchor="middle" class="label">${(d.supplySp / 10).toFixed(1)} °C sp</text></g>
    <path d="M320 85 H340" class="pipe air${water && !d.released ? " flow" : ""}"/>
    <rect x="336" y="50" width="134" height="104" rx="6" class="hall ${hot}"/>
    ${racks}
    <text x="403" y="44" text-anchor="middle" class="label">${esc(t.hall ?? "data hall")}</text>
    <text x="403" y="172" text-anchor="middle" class="big small">${d.coldAisle.toFixed(1)} °C</text>
    <text x="403" y="188" text-anchor="middle" class="label">cold aisle, max ${p.recommendedMax} °C</text>
    <text x="150" y="140" class="label">Chilled water ${d.chws.toFixed(1)} °C</text>
    <text x="150" y="156" class="label">setpoint ${(d.chwSp / 10).toFixed(1)} °C</text>
    ${shield(500, 70, d.released || d.fireIsolated ? "bad" : "ok", fp, d.released ? "RELEASED" : d.fireIsolated ? "ISOLATED" : "armed")}
    <text x="10" y="240" class="label">IT load ${Math.round(d.load)} kW${d.itShutdown ? " (thermal shutdown)" : ""}, cooling ${d.coolingPower} kW, PUE ${d.pue.toFixed(2)}</text>
  </svg>`;
}

function picture(sim: Sim): string {
  const m = sim.plant;
  if (m instanceof WaterTank) return waterMimic(sim, m);
  if (m instanceof GasCompressor) return gasMimic(sim, m);
  if (m instanceof DcCooling) return dcMimic(sim, m);
  return "";
}

function spark(values: number[], max: number, cls: string): string {
  if (values.length < 2) return `<svg class="spark" viewBox="0 0 200 40" width="100%"><text x="4" y="24" class="label">collecting…</text></svg>`;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * 200).toFixed(1)},${(38 - (Math.min(Math.max(v, 0), max) / max) * 36).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 200 40" width="100%" preserveAspectRatio="none"><polyline points="${pts}" class="${cls}"/></svg>`;
}

export function plantPanel(sim: Sim): string {
  const flows = sim.requiredFlows();
  const risks = sim.risks();
  const alarms = sim.plant.alarms();
  const trend = sim.trend.slice(-120);
  const open = sim.alerts.filter((a) => !a.acked).slice(-8).reverse();
  const minutes = Math.max(1, Math.round((trend.length * 5) / 60));
  const trends = sim.plant.trends
    .map((tr, i) => `<div><span class="meta">${esc(tr.label)}${i === 0 ? `, last ${minutes} min` : ""}</span>${spark(trend.map((x) => x.values[i] ?? 0), tr.max, i === 0 ? "lvl" : "cl")}</div>`)
    .join("");
  const readouts = sim.readouts();
  return `<h2>${esc(sim.site.name)}</h2>
  <h3>Process</h3>
  ${picture(sim)}
  <div class="trends">${trends}</div>
  <table class="readouts">${readouts.map((r) => `<tr><td>${esc(r.label)}</td><td class="st-${r.state}">${esc(r.text)}</td><td class="meta">${esc(r.note ?? "")}</td></tr>`).join("")}</table>
  ${alarms.length ? `<ul class="alarms">${alarms.map((a) => `<li class="sev-${a.severity}">${esc(a.text)}</li>`).join("")}</ul>` : `<p class="meta">No process alarms.</p>`}
  <h3>Plant data flows (${flows.filter((f) => f.ok).length}/${flows.length})</h3>
  <ul class="results">${flows.map((f) => `<li class="${f.ok ? "ok" : "bad"}">${esc(f.flow.title)}${f.ok ? "" : `<span class="detail">${esc(f.reason)}</span>`}</li>`).join("")}</ul>
  <h3>Security checks (${risks.filter((r) => r.ok).length}/${risks.length})</h3>
  <ul class="results">${risks.map((r) => `<li class="${r.ok ? "ok" : "bad"}">${esc(r.title)}<span class="detail">${esc(r.detail)}</span></li>`).join("")}</ul>
  <h3>Open alerts</h3>
  ${open.length ? `<ul class="alert-list">${open.map((a) => `<li class="sev-${a.severity}"><code>${esc(a.id)}</code> ${esc(a.title)}${a.src ? ` <span class="meta">from ${esc(a.src)}</span>` : ""}</li>`).join("")}</ul><p class="meta">Details in the terminal: <code>alerts show ID</code></p>` : `<p class="meta">No open alerts.</p>`}`;
}
