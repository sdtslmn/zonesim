// HMI screen definitions for the built-in process models: the overview
// graphic, the equipment you can click, their faceplates and the alarms.
//
// Everything is read from what the HMI host last polled (sim.hmiValues), not
// from the real process, and every command is a Modbus write from the HMI
// host to its controller. The screens follow the high-performance HMI style:
// grey, calm, colour only for alarms, and magenta for values the HMI cannot
// trust because it lost communication.

import type { Sim } from "@zonesim/core";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export interface Ctx {
  sim: Sim;
  tags: Record<string, string>;
  params: Record<string, number>;
  /** Raw value the HMI holds for a signal; NaN when no controller it polls has it. */
  v(signal: string): number;
  /** True when the HMI reads the signal at all. */
  has(signal: string): boolean;
  /** True when the value is recent (the controller answered lately). */
  fresh(signal: string): boolean;
  /** Is this object selected (for the outline)? */
  selected(id: string): boolean;
  /** Highest unacknowledged or active alarm priority on an object, if any. */
  alarmOn(id: string): { prio: number; unacked: boolean } | undefined;
}

export interface Row {
  label: string;
  /** A number: signal, scale (raw / scale = value), digits and unit. */
  sig?: string;
  scale?: number;
  digits?: number;
  unit?: string;
  /** A state: text for 1 and 0. */
  on?: string;
  off?: string;
  /** Show the 1 state as abnormal. */
  bad?: boolean;
}

export type Control =
  | {
      kind: "pair";
      sig: string;
      label: string;
      /** Button text for writing 1, then 0. */
      one: string;
      zero: string;
      /** Ask before writing this value. */
      confirm?: { value: 0 | 1; text: string };
      /** Undefined when allowed, or why not. */
      blocked?: (c: Ctx) => string | undefined;
    }
  | {
      kind: "setpoint";
      sig: string;
      label: string;
      scale: number;
      digits: number;
      unit: string;
      min: number;
      max: number;
      blocked?: (c: Ctx) => string | undefined;
      /** Extra check on the value typed, in engineering units. */
      check?: (c: Ctx, value: number) => string | undefined;
    };

export interface HmiObject {
  id: string;
  tag: string;
  title: string;
  rows: Row[];
  controls: Control[];
  note?: (c: Ctx) => string | undefined;
}

export interface HmiAlarm {
  id: string;
  /** 1 urgent, 2 high, 3 low. */
  prio: 1 | 2 | 3;
  text: string;
  obj?: string;
  active: (c: Ctx) => boolean;
}

export interface ScreenDef {
  objects: HmiObject[];
  alarms: HmiAlarm[];
  svg: (c: Ctx) => string;
}

// ---------------------------------------------------------------- drawing helpers

const on = (c: Ctx, sig: string) => c.v(sig) >= 1;

function num(c: Ctx, sig: string, scale: number, digits: number): string {
  if (!c.has(sig)) return "----";
  const v = c.v(sig);
  return Number.isFinite(v) ? (v / scale).toFixed(digits) : "----";
}

/** A value box: white field, value right-aligned, unit beside it. */
function box(c: Ctx, x: number, y: number, sig: string, scale: number, digits: number, unit: string, opts: { w?: number; tag?: string; alarm?: boolean } = {}): string {
  const w = opts.w ?? 58;
  const stale = c.has(sig) && !c.fresh(sig);
  const cls = `hv${stale ? " stale" : ""}${opts.alarm ? " alarm" : ""}${!c.has(sig) ? " none" : ""}`;
  const tag = opts.tag ? `<text x="${x}" y="${y - 4}" class="h-tag">${esc(opts.tag)}</text>` : "";
  return `${tag}<rect x="${x}" y="${y}" width="${w}" height="18" class="${cls}"/><text x="${x + w - 4}" y="${y + 13}" text-anchor="end" class="h-val${stale ? " stale" : ""}">${num(c, sig, scale, digits)}</text><text x="${x + w + 4}" y="${y + 13}" class="h-unit">${esc(unit)}</text>`;
}

/** An alarm indicator: priority 1 red square, 2 amber triangle, 3 blue circle. Blinks while unacknowledged. */
function alarmMark(c: Ctx, id: string, x: number, y: number): string {
  const a = c.alarmOn(id);
  if (!a) return "";
  const cls = `h-alm p${a.prio}${a.unacked ? " blink" : ""}`;
  const shape =
    a.prio === 1
      ? `<rect x="${x - 8}" y="${y - 8}" width="16" height="16"/>`
      : a.prio === 2
        ? `<path d="M${x} ${y - 9} L${x + 9} ${y + 7} L${x - 9} ${y + 7} Z"/>`
        : `<circle cx="${x}" cy="${y}" r="8"/>`;
  return `<g class="${cls}">${shape}<text x="${x}" y="${y + 4}" text-anchor="middle">${a.prio}</text></g>`;
}

/** A clickable piece of equipment. */
function obj(c: Ctx, id: string, inner: string, hit: { x: number; y: number; w: number; h: number }): string {
  return `<g class="h-obj${c.selected(id) ? " sel" : ""}" data-obj="${id}" tabindex="0" role="button"><rect class="h-hit" x="${hit.x}" y="${hit.y}" width="${hit.w}" height="${hit.h}" rx="4"/>${inner}</g>`;
}

function pump(x: number, y: number, running: boolean, stale: boolean): string {
  return `<g class="h-pump${running ? " run" : ""}${stale ? " stale" : ""}"><circle cx="${x}" cy="${y}" r="15"/><path d="M${x - 6} ${y - 9} L${x + 10} ${y} L${x - 6} ${y + 9} Z"/></g>`;
}

function valve(x: number, y: number, open: boolean, vertical = false): string {
  const d = vertical ? `M${x - 9} ${y - 11} L${x + 9} ${y - 11} L${x - 9} ${y + 11} L${x + 9} ${y + 11} Z` : `M${x - 11} ${y - 9} L${x - 11} ${y + 9} L${x + 11} ${y - 9} L${x + 11} ${y + 9} Z`;
  return `<path class="h-valve${open ? "" : " closed"}" d="${d}"/>`;
}

const label = (x: number, y: number, text: string, cls = "h-label", anchor = "start") => `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}">${esc(text)}</text>`;
const state = (x: number, y: number, text: string, bad = false, anchor = "middle", inv = false) => `<text x="${x}" y="${y}" class="h-state${bad ? " bad" : ""}${inv ? " inv" : ""}" text-anchor="${anchor}">${esc(text)}</text>`;

/** Blocked while in auto (for manual-only commands). */
const manualOnly = (modeSig: string, why: string) => (c: Ctx) => (on(c, modeSig) ? why : undefined);
const autoOnly = (modeSig: string, why: string) => (c: Ctx) => (on(c, modeSig) ? undefined : why);

// ---------------------------------------------------------------- water treatment

function water(sim: Sim): ScreenDef {
  const t = sim.plant.tags;
  const p = sim.plant.params;
  const sis = sim.safetyName ?? "SIS";
  const objects: HmiObject[] = [
    {
      id: "pump",
      tag: t.pump ?? "P-101",
      title: "Inlet pump",
      rows: [
        { label: "State", sig: "pump.running", on: "Running", off: "Stopped" },
        { label: "Mode", sig: "control.auto", on: "Auto (level control)", off: "Manual" },
        { label: "Manual command", sig: "pump.command", on: "Start", off: "Stop" },
      ],
      controls: [
        { kind: "pair", sig: "control.auto", label: "Mode", one: "Auto", zero: "Manual" },
        { kind: "pair", sig: "pump.command", label: "Pump", one: "Start", zero: "Stop", blocked: manualOnly("control.auto", "In auto the PLC starts and stops the pump on the level setpoints. Switch to manual first.") },
      ],
    },
    {
      id: "tank",
      tag: t.tank ?? "T-101",
      title: "Storage tank",
      rows: [
        { label: "Level", sig: "level", scale: 10, digits: 1, unit: "%" },
        { label: "Pump start level", sig: "setpoint.start", scale: 10, digits: 1, unit: "%" },
        { label: "Pump stop level", sig: "setpoint.stop", scale: 10, digits: 1, unit: "%" },
        { label: "High alarm", sig: "alarm.high", on: "Active", off: "Normal", bad: true },
        { label: "Low alarm", sig: "alarm.low", on: "Active", off: "Normal", bad: true },
      ],
      controls: [
        { kind: "setpoint", sig: "setpoint.start", label: "Start level", scale: 10, digits: 1, unit: "%", min: 5, max: Math.max(10, p.highAlarm - 10), check: (c, v) => (v * 10 >= c.v("setpoint.stop") ? `The start level must be below the stop level (${num(c, "setpoint.stop", 10, 1)} %).` : undefined) },
        { kind: "setpoint", sig: "setpoint.stop", label: "Stop level", scale: 10, digits: 1, unit: "%", min: 10, max: p.highAlarm, check: (c, v) => (v * 10 <= c.v("setpoint.start") ? `The stop level must be above the start level (${num(c, "setpoint.start", 10, 1)} %).` : undefined) },
      ],
      note: () => `The setpoints apply in auto mode. The HMI keeps the stop level at or below the high alarm (${p.highAlarm} %).`,
    },
    {
      id: "dosing",
      tag: t.dosing ?? "P-201",
      title: "Chlorine dosing",
      rows: [
        { label: "State", sig: "dosing.running", on: "Running", off: "Stopped" },
        { label: "Enabled", sig: "dosing.enable", on: "Yes", off: "No" },
        { label: "Chlorine residual", sig: "chlorine", scale: 100, digits: 2, unit: "mg/L" },
        { label: "Setpoint", sig: "setpoint.chlorine", scale: 100, digits: 2, unit: "mg/L" },
      ],
      controls: [
        { kind: "pair", sig: "dosing.enable", label: "Dosing", one: "Start", zero: "Stop", confirm: { value: 0, text: "Stop chlorine dosing? The residual will fall and the water may become unsafe to drink." } },
        { kind: "setpoint", sig: "setpoint.chlorine", label: "Setpoint", scale: 100, digits: 2, unit: "mg/L", min: p.chlorineLow, max: p.chlorineHigh },
      ],
    },
    {
      id: "sis",
      tag: sis,
      title: "Safety instrumented system",
      rows: [
        { label: "High-high trip", sig: "sis.tripped", on: "Tripped", off: "Armed", bad: true },
        { label: "Bypass", sig: "sis.bypassed", on: "Bypassed", off: "Not bypassed", bad: true },
        { label: "Independent level", sig: "sis.level", scale: 10, digits: 1, unit: "%" },
        { label: "Trip level", sig: "sis.trip_level", scale: 10, digits: 1, unit: "%" },
      ],
      controls: [],
      note: () => "The safety system is independent of the PLC. The HMI shows its state but cannot change it: bypasses are set from the engineering workstation, under a permit.",
    },
  ];
  const alarms: HmiAlarm[] = [
    { id: "overflow", prio: 1, text: `${t.tank ?? "Tank"} overflowing`, obj: "tank", active: (c) => on(c, "alarm.overflow") },
    { id: "sis-bypass", prio: 1, text: `${sis} high-high trip bypassed`, obj: "sis", active: (c) => on(c, "sis.bypassed") },
    { id: "sis-trip", prio: 1, text: `${sis} trip: inlet pump held off`, obj: "sis", active: (c) => on(c, "sis.tripped") },
    { id: "cl-low", prio: 1, text: "Chlorine low: water may be unsafe", obj: "dosing", active: (c) => c.has("chlorine") && c.v("chlorine") < p.chlorineLow * 100 },
    { id: "high", prio: 2, text: `${t.tank ?? "Tank"} level high`, obj: "tank", active: (c) => on(c, "alarm.high") },
    { id: "low", prio: 2, text: `${t.tank ?? "Tank"} level low`, obj: "tank", active: (c) => on(c, "alarm.low") },
    { id: "cl-high", prio: 2, text: "Chlorine high: overdosing", obj: "dosing", active: (c) => c.has("chlorine") && c.v("chlorine") > p.chlorineHigh * 100 },
    { id: "dosing-off", prio: 3, text: "Chlorine dosing disabled", obj: "dosing", active: (c) => c.has("dosing.enable") && !on(c, "dosing.enable") },
  ];
  const svg = (c: Ctx) => {
    const run = on(c, "pump.running");
    const dose = on(c, "dosing.running");
    const lvl = Math.min(100, Math.max(0, c.v("level") / 10)) || 0;
    const tx = 300;
    const ty = 60;
    const tw = 120;
    const th = 190;
    const mark = (sig: string, name: string, cls = "") => {
      if (!c.has(sig)) return "";
      const y = ty + th - (th * Math.min(Math.max(c.v(sig), 0), 1000)) / 1000;
      return `<line x1="${tx + tw}" y1="${y}" x2="${tx + tw + 9}" y2="${y}" class="h-mark ${cls}"/><text x="${tx + tw + 13}" y="${y + 4}" class="h-small ${cls}">${name} ${num(c, sig, 10, 1)}</text>`;
    };
    const sisBad = on(c, "sis.bypassed") || on(c, "sis.tripped");
    return `<svg class="hmi-svg" viewBox="0 0 720 330" width="100%">
      ${label(20, 141, (t.source ?? "source").toUpperCase(), "h-small")}
      <path d="M20 150 H95" class="h-pipe${run ? " flow" : ""}"/>
      <path d="M125 150 H200 V80 H${tx}" class="h-pipe${run ? " flow" : ""}"/>
      ${obj(c, "pump", `${pump(110, 150, run, !c.fresh("pump.running"))}${label(110, 186, t.pump ?? "P-101", "h-tagname", "middle")}${state(110, 200, run ? "RUN" : "STOP")}${state(110, 122, on(c, "control.auto") ? "AUTO" : "MAN")}${alarmMark(c, "pump", 136, 128)}`, { x: 86, y: 108, w: 50, h: 98 })}
      <path d="M125 262 H260 V232 H${tx}" class="h-pipe thin${dose ? " flow" : ""}"/>
      ${obj(c, "dosing", `${pump(110, 262, dose, !c.fresh("dosing.running"))}${label(110, 298, t.dosing ?? "P-201", "h-tagname", "middle")}${state(110, 312, dose ? "RUN" : "STOP")}${alarmMark(c, "dosing", 138, 244)}`, { x: 86, y: 240, w: 56, h: 78 })}
      ${obj(
        c,
        "tank",
        `<rect x="${tx}" y="${ty}" width="${tw}" height="${th}" class="h-vessel"/>
        <rect x="${tx + 1}" y="${ty + th - (th * lvl) / 100}" width="${tw - 2}" height="${(th * lvl) / 100}" class="h-fill${c.fresh("level") ? "" : " stale"}"/>
        ${label(tx + tw / 2, ty - 10, t.tank ?? "T-101", "h-tagname", "middle")}
        ${box(c, tx + 26, ty + th / 2 - 9, "level", 10, 1, "%", { w: 58, alarm: on(c, "alarm.high") || on(c, "alarm.low") })}
        ${mark("setpoint.stop", "STOP")}${mark("setpoint.start", "START")}${mark("sis.trip_level", "SIS", "trip")}
        ${alarmMark(c, "tank", tx - 14, ty + 10)}`,
        { x: tx - 24, y: ty - 26, w: tw + 110, h: th + 32 },
      )}
      <path d="M${tx + tw / 2} ${ty + th} V290 H700" class="h-pipe flow"/>
      ${label(700, 281, (t.consumer ?? "consumers").toUpperCase(), "h-small", "end")}
      ${obj(c, "dosing", `<path d="M546 290 V276" class="h-pipe thin"/>${box(c, 520, 258, "chlorine", 100, 2, "mg/L", { w: 52, tag: "AIT-201 CHLORINE", alarm: c.has("chlorine") && (c.v("chlorine") < p.chlorineLow * 100 || c.v("chlorine") > p.chlorineHigh * 100) })}`, { x: 512, y: 242, w: 110, h: 40 })}
      ${obj(
        c,
        "sis",
        `<rect x="540" y="60" width="150" height="96" class="h-panel${sisBad ? " bad" : ""}"/>
        ${label(552, 80, `${sis}  SAFETY`, "h-tagname")}
        ${state(552, 102, on(c, "sis.bypassed") ? "BYPASSED" : on(c, "sis.tripped") ? "TRIPPED" : "ARMED", sisBad, "start")}
        ${box(c, 552, 116, "sis.level", 10, 1, "%", { w: 50, tag: "" })}
        ${label(628, 129, "LT-102", "h-small")}
        ${alarmMark(c, "sis", 676, 76)}`,
        { x: 534, y: 54, w: 162, h: 108 },
      )}
    </svg>`;
  };
  return { objects, alarms, svg };
}

// ---------------------------------------------------------------- gas compressor

function gas(sim: Sim): ScreenDef {
  const t = sim.plant.tags;
  const p = sim.plant.params;
  const esd = sim.safetyName ?? "ESD";
  const objects: HmiObject[] = [
    {
      id: "compressor",
      tag: t.compressor ?? "K-101",
      title: "Compressor",
      rows: [
        { label: "State", sig: "compressor.running", on: "Running", off: "Stopped" },
        { label: "Speed", sig: "speed", scale: 10, digits: 1, unit: "%" },
        { label: "Mode", sig: "control.auto", on: "Auto (pressure control)", off: "Manual speed" },
        { label: "Suction pressure", sig: "pressure.suction", scale: 10, digits: 1, unit: "bar" },
        { label: "Discharge pressure", sig: "pressure.discharge", scale: 10, digits: 1, unit: "bar" },
        { label: "Pressure setpoint", sig: "setpoint.discharge", scale: 10, digits: 1, unit: "bar" },
        { label: "Station flow", sig: "flow", scale: 1, digits: 0, unit: "kSm³/h" },
      ],
      controls: [
        { kind: "pair", sig: "compressor.run", label: "Compressor", one: "Start", zero: "Stop", confirm: { value: 0, text: `Stop ${t.compressor ?? "the compressor"}? Downstream pressure will fall.` } },
        { kind: "pair", sig: "control.auto", label: "Mode", one: "Auto", zero: "Manual" },
        { kind: "setpoint", sig: "setpoint.discharge", label: "Pressure setpoint", scale: 10, digits: 1, unit: "bar", min: p.lowAlarm, max: p.highAlarm - 1, blocked: autoOnly("control.auto", "The pressure setpoint applies in auto. In manual you set the speed.") },
        { kind: "setpoint", sig: "setpoint.speed", label: "Manual speed", scale: 10, digits: 1, unit: "%", min: 0, max: 100, blocked: manualOnly("control.auto", "In auto the speed follows the pressure setpoint. Switch to manual first.") },
      ],
      note: () => `The HMI keeps the pressure setpoint between the low alarm (${p.lowAlarm} bar) and just under the high alarm (${p.highAlarm} bar).`,
    },
    {
      id: "antisurge",
      tag: t.recycle ?? "UV-101",
      title: "Anti-surge recycle valve",
      rows: [
        { label: "Position", sig: "recycle", scale: 10, digits: 1, unit: "% open" },
        { label: "Surge margin", sig: "surge.margin", scale: 1, digits: 0, unit: "%" },
        { label: "Mode", sig: "antisurge.auto", on: "Auto (anti-surge control)", off: "Manual" },
        { label: "Surge", sig: "alarm.surge", on: "SURGE", off: "No", bad: true },
      ],
      controls: [
        { kind: "pair", sig: "antisurge.auto", label: "Mode", one: "Auto", zero: "Manual", confirm: { value: 0, text: "Put anti-surge control in manual? Nothing will open the valve if the compressor nears surge." } },
        { kind: "setpoint", sig: "setpoint.recycle", label: "Manual position", scale: 10, digits: 1, unit: "%", min: 0, max: 100, blocked: manualOnly("antisurge.auto", "In auto the anti-surge controller moves the valve. Switch to manual first.") },
      ],
    },
    {
      id: "esd",
      tag: esd,
      title: "Emergency shutdown system",
      rows: [
        { label: "Trip", sig: "sis.tripped", on: "Tripped", off: "Armed", bad: true },
        { label: `${t.esd ?? "ESD valve"}`, sig: "valve.esd_closed", on: "Closed", off: "Open", bad: true },
        { label: "Pressure trip bypass", sig: "sis.bypassed", on: "Bypassed", off: "Not bypassed", bad: true },
        { label: "Independent pressure", sig: "sis.pressure", scale: 10, digits: 1, unit: "bar" },
      ],
      controls: [],
      note: () => "The ESD system is independent of the unit controller. The HMI shows its state but cannot change it.",
    },
    {
      id: "psv",
      tag: t.relief ?? "PSV-103",
      title: "Relief valve",
      rows: [{ label: "State", sig: "alarm.venting", on: "Lifting: venting gas", off: "Closed", bad: true }],
      controls: [],
      note: () => `A spring-loaded valve set at ${p.reliefPressure} bar. It is the last layer of protection and has no remote control.`,
    },
  ];
  const alarms: HmiAlarm[] = [
    { id: "surge", prio: 1, text: `${t.compressor ?? "Compressor"} in surge`, obj: "compressor", active: (c) => on(c, "alarm.surge") },
    { id: "venting", prio: 1, text: `${t.relief ?? "Relief valve"} lifting: gas venting`, obj: "psv", active: (c) => on(c, "alarm.venting") },
    { id: "esd-trip", prio: 1, text: `${esd} trip: ${t.esd ?? "ESD valve"} closed`, obj: "esd", active: (c) => on(c, "sis.tripped") },
    { id: "esd-bypass", prio: 1, text: `${esd} pressure trip bypassed`, obj: "esd", active: (c) => on(c, "sis.bypassed") },
    { id: "high-pressure", prio: 2, text: "Discharge pressure high", obj: "compressor", active: (c) => on(c, "alarm.high_pressure") },
    { id: "low-margin", prio: 3, text: "Surge margin low", obj: "antisurge", active: (c) => c.has("surge.margin") && on(c, "compressor.running") && c.v("surge.margin") > 0 && c.v("surge.margin") < 5 },
    { id: "antisurge-manual", prio: 3, text: "Anti-surge control in manual", obj: "antisurge", active: (c) => c.has("antisurge.auto") && !on(c, "antisurge.auto") },
  ];
  const svg = (c: Ctx) => {
    const run = on(c, "compressor.running");
    const esdClosed = on(c, "valve.esd_closed");
    const recycleOpen = c.v("recycle") > 5;
    const flowing = c.v("flow") > 0;
    const esdBad = on(c, "sis.tripped") || on(c, "sis.bypassed");
    return `<svg class="hmi-svg" viewBox="0 0 720 350" width="100%">
      ${label(20, 180, (t.source ?? "upstream").toUpperCase(), "h-small")}
      <path d="M20 160 H275" class="h-pipe${flowing ? " flow" : ""}"/>
      <path d="M345 160 H700" class="h-pipe${flowing && !esdClosed ? " flow" : ""}"/>
      ${label(700, 180, (t.consumer ?? "downstream").toUpperCase(), "h-small", "end")}
      ${obj(c, "compressor", `${box(c, 120, 124, "pressure.suction", 10, 1, "bar", { tag: "PT-100" })}`, { x: 114, y: 108, w: 104, h: 40 })}
      ${obj(
        c,
        "compressor",
        `<path d="M275 128 L345 145 L345 175 L275 192 Z" class="h-machine${run ? " run" : ""}${c.fresh("compressor.running") ? "" : " stale"}"/>
        ${label(310, 116, t.compressor ?? "K-101", "h-tagname", "middle")}
        ${state(310, 208, `${run ? "RUN" : "STOP"}  ${on(c, "control.auto") ? "AUTO" : "MAN"}`)}
        ${box(c, 282, 226, "speed", 10, 1, "%", { w: 46, tag: "SI-101" })}
        ${alarmMark(c, "compressor", 352, 124)}`,
        { x: 266, y: 100, w: 92, h: 152 },
      )}
      ${obj(c, "compressor", `${box(c, 380, 124, "pressure.discharge", 10, 1, "bar", { tag: "PT-101", alarm: on(c, "alarm.high_pressure") })}${label(380, 188, `SP ${num(c, "setpoint.discharge", 10, 1)} bar`, "h-small")}`, { x: 374, y: 108, w: 104, h: 86 })}
      ${obj(
        c,
        "psv",
        `<path d="M500 160 V112" class="h-pipe thin"/><path d="M490 112 L510 112 L500 96 Z" class="h-psv${on(c, "alarm.venting") ? " bad" : ""}"/>${label(516, 104, t.relief ?? "PSV-103", "h-tagname")}${on(c, "alarm.venting") ? state(516, 120, "VENTING", true, "start") : ""}${alarmMark(c, "psv", 484, 92)}`,
        { x: 484, y: 84, w: 92, h: 66 },
      )}
      ${obj(c, "esd", `${valve(570, 160, !esdClosed)}${label(570, 196, t.esd ?? "SDV-102", "h-tagname", "middle")}${state(570, 210, esdClosed ? "CLOSED" : "OPEN", esdClosed)}`, { x: 548, y: 142, w: 44, h: 74 })}
      ${obj(c, "compressor", `${box(c, 622, 124, "flow", 1, 0, "kSm³/h", { w: 44, tag: "FI-101" })}`, { x: 616, y: 108, w: 100, h: 40 })}
      ${obj(
        c,
        "esd",
        `<rect x="530" y="240" width="160" height="70" class="h-panel${esdBad ? " bad" : ""}"/>
        ${label(542, 260, `${esd}  ESD`, "h-tagname")}
        ${state(542, 282, on(c, "sis.bypassed") ? "BYPASSED" : on(c, "sis.tripped") ? "TRIPPED" : "ARMED", esdBad, "start")}
        ${box(c, 610, 272, "sis.pressure", 10, 1, "bar", { w: 46 })}
        ${alarmMark(c, "esd", 676, 256)}`,
        { x: 524, y: 234, w: 172, h: 82 },
      )}
      <path d="M440 160 V300 H200 V160" class="h-pipe thin${recycleOpen && run ? " flow" : ""}"/>
      ${obj(
        c,
        "antisurge",
        `${valve(320, 300, recycleOpen)}${label(320, 284, t.recycle ?? "UV-101", "h-tagname", "end")}
        ${state(328, 284, on(c, "antisurge.auto") ? "AUTO" : "MAN", !on(c, "antisurge.auto"), "start")}
        ${box(c, 232, 314, "recycle", 10, 1, "% open", { w: 46 })}
        ${box(c, 352, 314, "surge.margin", 1, 0, "% margin", { w: 32 })}
        ${alarmMark(c, "antisurge", 300, 276)}`,
        { x: 222, y: 270, w: 220, h: 70 },
      )}
    </svg>`;
  };
  return { objects, alarms, svg };
}

// ---------------------------------------------------------------- data centre cooling

function dc(sim: Sim): ScreenDef {
  const t = sim.plant.tags;
  const p = sim.plant.params;
  const panel = sim.roleHost("sis")?.name ?? "fire panel";
  const chiller = (n: 1 | 2): HmiObject => ({
    id: `ch${n}`,
    tag: t[`chiller${n}`] ?? `CH-${n}`,
    title: "Chiller",
    rows: [
      { label: "State", sig: `chiller${n}.running`, on: "Running", off: "Stopped" },
      { label: "Available for duty", sig: `chiller${n}.enable`, on: "Yes", off: "No (out of service)" },
    ],
    controls: [
      { kind: "pair", sig: `chiller${n}.enable`, label: "Duty", one: "Enable", zero: "Disable", confirm: { value: 0, text: `Take ${t[`chiller${n}`] ?? `CH-${n}`} out of service? The hall loses its N+1 redundancy.` } },
    ],
    note: (c) => (on(c, "control.auto") ? "In auto the controller runs the chillers it needs and keeps one in reserve." : "In manual every enabled chiller runs."),
  });
  const objects: HmiObject[] = [
    chiller(1),
    chiller(2),
    {
      id: "pump",
      tag: t.pump ?? "CHWP-1",
      title: "Chilled water pumps",
      rows: [
        { label: "State", sig: "pump.running", on: "Running", off: "Stopped" },
        { label: "Command", sig: "pump.run", on: "Run", off: "Stop" },
      ],
      controls: [{ kind: "pair", sig: "pump.run", label: "Pumps", one: "Start", zero: "Stop", confirm: { value: 0, text: "Stop the chilled water pumps? All cooling to the hall stops." } }],
    },
    {
      id: "plant",
      tag: "CPC",
      title: "Cooling plant control",
      rows: [
        { label: "Mode", sig: "control.auto", on: "Auto (N+1)", off: "Manual" },
        { label: "Chilled water supply", sig: "temp.chw_supply", scale: 10, digits: 1, unit: "°C" },
        { label: "Chilled water setpoint", sig: "setpoint.chw", scale: 10, digits: 1, unit: "°C" },
        { label: "Supply air setpoint", sig: "setpoint.supply_air", scale: 10, digits: 1, unit: "°C" },
      ],
      controls: [
        { kind: "pair", sig: "control.auto", label: "Mode", one: "Auto", zero: "Manual" },
        { kind: "setpoint", sig: "setpoint.chw", label: "Chilled water setpoint", scale: 10, digits: 1, unit: "°C", min: 6, max: 20 },
        { kind: "setpoint", sig: "setpoint.supply_air", label: "Supply air setpoint", scale: 10, digits: 1, unit: "°C", min: 18, max: p.recommendedMax },
      ],
    },
    {
      id: "hall",
      tag: t.hall ?? "Data hall 1",
      title: "Data hall",
      rows: [
        { label: "Cold aisle", sig: "temp.cold_aisle", scale: 10, digits: 1, unit: "°C" },
        { label: "IT load", sig: "load.it", scale: 1, digits: 0, unit: "kW" },
        { label: "Cooling power", sig: "power.cooling", scale: 1, digits: 0, unit: "kW" },
        { label: "PUE", sig: "pue", scale: 100, digits: 2, unit: "" },
      ],
      controls: [],
      note: () => `Recommended server inlet range up to ${p.recommendedMax} °C, allowable up to ${p.allowableMax} °C. Servers shut down above ${p.shutdownTemp} °C.`,
    },
    {
      id: "fire",
      tag: panel,
      title: "Fire alarm and suppression panel",
      rows: [
        { label: "Fire alarm", sig: "fire.alarm", on: "FIRE", off: "Normal", bad: true },
        { label: "Suppression", sig: "fire.isolated", on: "Isolated", off: "Armed", bad: true },
        { label: "Clean agent", sig: "fire.discharged", on: "Released", off: "Not released", bad: true },
        { label: "Heat detectors", sig: "fire.temp", scale: 10, digits: 1, unit: "°C" },
      ],
      controls: [],
      note: () => "The fire panel is a life safety system. The BMS shows its state but cannot change it.",
    },
  ];
  const alarms: HmiAlarm[] = [
    { id: "fire", prio: 1, text: "Fire alarm in the hall", obj: "fire", active: (c) => on(c, "fire.alarm") },
    { id: "discharged", prio: 1, text: `${t.agent ?? "Clean agent"} released`, obj: "fire", active: (c) => on(c, "fire.discharged") },
    { id: "critical", prio: 1, text: "Cold aisle above the allowable range", obj: "hall", active: (c) => on(c, "alarm.critical_temp") },
    { id: "pumps", prio: 1, text: "Chilled water pumps stopped", obj: "pump", active: (c) => c.has("pump.running") && !on(c, "pump.running") },
    { id: "no-chiller", prio: 1, text: "No chiller running", obj: "plant", active: (c) => c.has("chiller1.running") && !on(c, "chiller1.running") && !on(c, "chiller2.running") },
    { id: "high", prio: 2, text: "Cold aisle above the recommended range", obj: "hall", active: (c) => on(c, "alarm.high_temp") },
    { id: "isolated", prio: 2, text: "Fire suppression isolated", obj: "fire", active: (c) => on(c, "fire.isolated") },
    { id: "redundancy", prio: 3, text: "N+1 redundancy lost: a chiller is out of service", obj: "plant", active: (c) => c.has("chiller1.enable") && !(on(c, "chiller1.enable") && on(c, "chiller2.enable")) },
  ];
  const svg = (c: Ctx) => {
    const ch = (n: 1 | 2, y: number) => {
      const run = on(c, `chiller${n}.running`);
      const avail = on(c, `chiller${n}.enable`);
      return obj(
        c,
        `ch${n}`,
        `<rect x="40" y="${y}" width="110" height="56" rx="3" class="h-machine${run ? " run" : ""}${c.fresh(`chiller${n}.running`) ? "" : " stale"}"/>
        ${label(95, y + 24, t[`chiller${n}`] ?? `CH-${n}`, run ? "h-tagname inv" : "h-tagname", "middle")}
        ${state(95, y + 42, run ? "RUN" : avail ? "STANDBY" : "OUT OF SERVICE", !avail, "middle", run)}
        ${alarmMark(c, `ch${n}`, 158, y + 4)}`,
        { x: 34, y: y - 6, w: 132, h: 68 },
      );
    };
    const pumpRun = on(c, "pump.running");
    const aisleBad = on(c, "alarm.high_temp") || on(c, "alarm.critical_temp");
    return `<svg class="hmi-svg" viewBox="0 0 720 330" width="100%">
      ${ch(1, 50)}${ch(2, 150)}
      <path d="M150 78 H220 V178 H150 M220 128 H285" class="h-pipe${pumpRun ? " flow" : ""}"/>
      ${obj(c, "plant", `${box(c, 346, 98, "temp.chw_supply", 10, 1, "°C", { w: 44, tag: "TT CHWS" })}`, { x: 340, y: 82, w: 74, h: 38 })}
      ${obj(c, "pump", `${pump(300, 128, pumpRun, !c.fresh("pump.running"))}${label(300, 164, t.pump ?? "CHWP-1", "h-tagname", "middle")}${state(300, 178, pumpRun ? "RUN" : "STOP", !pumpRun)}${alarmMark(c, "pump", 326, 106)}`, { x: 276, y: 104, w: 56, h: 82 })}
      <path d="M315 128 H420" class="h-pipe${pumpRun ? " flow" : ""}"/>
      <rect x="420" y="98" width="90" height="60" rx="3" class="h-machine${pumpRun ? " run" : ""}"/>
      ${label(465, 124, t.crah ?? "CRAH units", pumpRun ? "h-tagname inv" : "h-tagname", "middle")}
      ${label(465, 142, "supply air", pumpRun ? "h-small inv" : "h-small", "middle")}
      <path d="M510 128 H560" class="h-pipe air"/>
      <path d="M465 158 V296 H20 V100 H40 M20 200 H40" class="h-pipe thin dashed"/>
      ${label(28, 290, "CHILLED WATER RETURN", "h-small")}
      ${obj(
        c,
        "hall",
        `<rect x="560" y="50" width="140" height="160" rx="3" class="h-vessel${aisleBad ? " bad" : ""}"/>
        ${label(570, 70, t.hall ?? "Data hall 1", "h-tagname")}
        ${box(c, 572, 96, "temp.cold_aisle", 10, 1, "°C", { w: 52, tag: "COLD AISLE", alarm: aisleBad })}
        ${box(c, 572, 140, "load.it", 1, 0, "kW", { w: 52, tag: "IT LOAD" })}
        ${box(c, 572, 184, "pue", 100, 2, "PUE", { w: 52, tag: "" })}
        ${alarmMark(c, "hall", 690, 62)}`,
        { x: 554, y: 44, w: 152, h: 172 },
      )}
      ${obj(
        c,
        "plant",
        `<rect x="190" y="210" width="190" height="62" class="h-panel"/>
        ${label(202, 228, "COOLING CONTROL", "h-tagname")}
        ${state(202, 246, on(c, "control.auto") ? "AUTO  N+1" : "MANUAL", false, "start")}
        ${label(202, 263, `CHWS SP ${num(c, "setpoint.chw", 10, 1)} °C   AIR SP ${num(c, "setpoint.supply_air", 10, 1)} °C`, "h-small")}
        ${alarmMark(c, "plant", 368, 222)}`,
        { x: 184, y: 204, w: 202, h: 74 },
      )}
      ${obj(
        c,
        "fire",
        `<rect x="560" y="236" width="140" height="66" class="h-panel${on(c, "fire.alarm") || on(c, "fire.discharged") || on(c, "fire.isolated") ? " bad" : ""}"/>
        ${label(572, 256, `${panel}  FIRE`, "h-tagname")}
        ${state(572, 276, on(c, "fire.discharged") ? "RELEASED" : on(c, "fire.alarm") ? "FIRE" : on(c, "fire.isolated") ? "ISOLATED" : "ARMED", on(c, "fire.alarm") || on(c, "fire.discharged") || on(c, "fire.isolated"), "start")}
        ${box(c, 572, 282, "fire.temp", 10, 1, "°C", { w: 44 })}
        ${alarmMark(c, "fire", 690, 248)}`,
        { x: 554, y: 230, w: 152, h: 78 },
      )}
    </svg>`;
  };
  return { objects, alarms, svg };
}

const SCREENS: Record<string, (sim: Sim) => ScreenDef> = { "water-tank": water, "gas-compressor": gas, "dc-cooling": dc };

/** The HMI screen for a site's process model, if ZoneSim has one. */
export function screenFor(sim: Sim): ScreenDef | undefined {
  return SCREENS[sim.plant.model]?.(sim);
}
