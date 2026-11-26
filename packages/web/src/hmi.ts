// The HMI tab: the operator screen of the plant's HMI host. It shows what the
// HMI last read from the controllers, and every command is a Modbus write
// from the HMI host across the network. When a conduit blocks the HMI or its
// switch port goes down, the screen goes stale and commands get no answer,
// as they would in a real control room.

import { clock, type Sim } from "@zonesim/core";
import { screenFor, type Control, type Ctx, type HmiObject, type Row, type ScreenDef } from "./hmi-screens";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

type Screen = "overview" | "alarms" | "events";

interface ActiveAlarm {
  id: string;
  prio: 1 | 2 | 3;
  text: string;
  obj?: string;
  since: number;
  acked: boolean;
}

export class HmiView {
  private el?: HTMLElement;
  private simRef?: Sim;
  private def?: ScreenDef;
  private screen: Screen = "overview";
  private selected?: string;
  private confirm?: { sig: string; value: number; text: string; action: string };
  private msg?: { ok: boolean; text: string; detail?: string };
  private alarms = new Map<string, ActiveAlarm>();
  private faceKey = "";

  constructor(
    private getSim: () => Sim,
    /** Called after the operator changed something, so the rest of the page can refresh. */
    private onAction: () => void,
  ) {}

  get mounted(): boolean {
    return !!this.el?.isConnected;
  }

  mount(el: HTMLElement): void {
    this.el = el;
    this.faceKey = "";
    el.innerHTML = `<div class="hmi">
      <div class="hmi-head" id="hmi-head"></div>
      <div class="hmi-main">
        <div class="hmi-screen" id="hmi-screen"></div>
        <aside class="hmi-face" id="hmi-face"></aside>
      </div>
      <div class="hmi-banner" id="hmi-banner"></div>
    </div>
    <p class="meta hmi-foot" id="hmi-foot"></p>`;
    el.addEventListener("click", (e) => this.click(e));
    el.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement;
      if (e.key === "Enter" && t.matches("input[data-sp]")) {
        e.preventDefault();
        this.submitSetpoint(t.dataset.sp!);
      } else if ((e.key === "Enter" || e.key === " ") && t.matches("[data-obj]")) {
        e.preventDefault();
        this.select(t.dataset.obj!);
      }
    });
    this.refresh();
  }

  unmount(): void {
    this.el = undefined;
  }

  // ------------------------------------------------------------ state

  private ctx(sim: Sim): Ctx {
    return {
      sim,
      tags: sim.plant.tags,
      params: sim.plant.params,
      v: (sig) => (sim.hmiSource(sig) ? (sim.hmiValues[sig] ?? NaN) : NaN),
      has: (sig) => !!sim.hmiSource(sig),
      fresh: (sig) => {
        const src = sim.hmiSource(sig);
        return !!src && sim.hmiFresh(src.device);
      },
      selected: (id) => this.selected === id,
      alarmOn: (id) => {
        const list = [...this.alarms.values()].filter((a) => a.obj === id);
        if (!list.length) return undefined;
        return { prio: Math.min(...list.map((a) => a.prio)), unacked: list.some((a) => !a.acked) };
      },
    };
  }

  /** Alarms come in and go out as the values the HMI reads change. Communication loss is an alarm too. */
  private updateAlarms(sim: Sim, c: Ctx): void {
    const now: { id: string; prio: 1 | 2 | 3; text: string; obj?: string }[] = [];
    for (const d of sim.hmiDevices()) if (!sim.hmiFresh(d)) now.push({ id: `comm-${d}`, prio: 2, text: `Communication lost with ${d}` });
    for (const a of this.def?.alarms ?? []) {
      // Alarms from a controller the HMI cannot hear are not trusted: the comm alarm covers them.
      if (a.active(c)) now.push({ id: a.id, prio: a.prio, text: a.text, obj: a.obj });
    }
    const ids = new Set(now.map((a) => a.id));
    for (const id of [...this.alarms.keys()]) if (!ids.has(id)) this.alarms.delete(id);
    for (const a of now) if (!this.alarms.has(a.id)) this.alarms.set(a.id, { ...a, since: sim.t, acked: false });
  }

  private sortedAlarms(): ActiveAlarm[] {
    return [...this.alarms.values()].sort((a, b) => Number(a.acked) - Number(b.acked) || a.prio - b.prio || b.since - a.since);
  }

  // ------------------------------------------------------------ render

  refresh(): void {
    if (!this.el?.isConnected) return;
    const sim = this.getSim();
    if (sim !== this.simRef) {
      this.simRef = sim;
      this.def = screenFor(sim);
      this.selected = undefined;
      this.confirm = undefined;
      this.msg = undefined;
      this.alarms.clear();
      this.faceKey = "";
    }
    const root = this.el;
    const hmi = sim.site.hmi;
    if (!hmi || !this.def) {
      const html = `<div class="notice info">${hmi ? `ZoneSim has no HMI screen for the ${esc(sim.plant.model)} process yet. Type <code>hmi</code> in the terminal for a text view.` : "This site has no HMI. Add an <code>hmi</code> section to the site file to get one."}</div>`;
      if (root.innerHTML !== html) root.innerHTML = html;
      return;
    }
    const c = this.ctx(sim);
    this.updateAlarms(sim, c);
    const set = (id: string, html: string) => {
      const n = root.querySelector<HTMLElement>(`#${id}`);
      if (n && n.innerHTML !== html) n.innerHTML = html;
    };
    set("hmi-head", this.headHtml(sim));
    set("hmi-screen", this.screenHtml(sim, c));
    set("hmi-banner", this.bannerHtml());
    const host = sim.hmiHost;
    const sb = sim.site.standby;
    const takeoverNote = sb ? (sim.takeover ? ` The ${esc(sb.centre)} is lost: ${esc(host)} at the ${esc(sb.backupName)} has taken over.` : ` If the ${esc(sb.centre)} is lost, ${esc(sb.backup)} at the ${esc(sb.backupName)} takes over this screen (<code>takeover start</code>).`) : "";
    set("hmi-foot", `This is the operator screen of <b>${esc(host)}</b>. It shows what ${esc(host)} last read from the controllers, and every button sends a Modbus write from ${esc(host)} to the controller across the network. The <a href="#" data-goto="plant">Plant</a> tab shows the real process.${takeoverNote}`);
    this.renderFace(sim, c);
  }

  private headHtml(sim: Sim): string {
    const hmi = sim.site.hmi!;
    const unacked = [...this.alarms.values()].filter((a) => !a.acked).length;
    const nav = (["overview", "alarms", "events"] as Screen[])
      .map((s) => {
        const text = s === "overview" ? "Overview" : s === "alarms" ? `Alarms${this.alarms.size ? ` (${this.alarms.size})` : ""}` : "Events";
        return `<button class="hmi-nav${this.screen === s ? " active" : ""}${s === "alarms" && unacked ? " unacked" : ""}" data-screen="${s}">${text}</button>`;
      })
      .join("");
    const comm = sim
      .hmiDevices()
      .map((d) => `<span class="hmi-comm${sim.hmiFresh(d) ? "" : " fail"}" title="${sim.hmiFresh(d) ? `${d} answers` : `No answer from ${d} for ${Math.round(sim.t - (sim.hmiLast[d] ?? 0))} s`}">${esc(d)} ${sim.hmiFresh(d) ? "OK" : "COMM FAIL"}</span>`)
      .join("");
    const sb = sim.site.standby;
    const where = sim.takeover && sb ? ` <span class="hmi-takeover">${esc(sb.backupName)} IN CONTROL</span>` : "";
    return `<span class="hmi-title"><b>${esc(sim.hmiHost)}</b> ${esc(sim.site.name)}${where}</span><nav class="hmi-navs">${nav}</nav><span class="hmi-comms">${comm}</span><span class="hmi-clock">${clock(sim.t)}</span>`;
  }

  private screenHtml(sim: Sim, c: Ctx): string {
    if (this.screen === "overview") return this.def!.svg(c);
    if (this.screen === "alarms") {
      const rows = this.sortedAlarms()
        .map((a) => `<tr class="p${a.prio}${a.acked ? " acked" : ""}"><td>${clock(a.since)}</td><td><span class="h-prio p${a.prio}">${a.prio}</span></td><td>${esc(a.text)}</td><td>${a.acked ? "Acknowledged" : "Unacknowledged"}</td><td>${a.acked ? "" : `<button class="hmi-btn small" data-ack="${esc(a.id)}">Ack</button>`}${a.obj ? ` <button class="hmi-btn small" data-show="${esc(a.obj)}">Show</button>` : ""}</td></tr>`)
        .join("");
      return rows
        ? `<table class="hmi-table"><tr><th>In</th><th>Prio</th><th>Alarm</th><th>State</th><th></th></tr>${rows}</table><p class="h-hint">Priority 1 needs action now, 2 soon, 3 when you can. Alarms clear by themselves when the condition goes away.</p>`
        : `<p class="h-empty">No active alarms.</p>`;
    }
    const rows = [...sim.hmiActions]
      .reverse()
      .map((a) => `<tr class="${a.ok ? "" : "failed"}"><td>${clock(a.t)}</td><td>${esc(a.text)}</td><td>${esc(a.result)}</td><td class="h-detail">${esc(a.detail ?? "")}</td></tr>`)
      .join("");
    return rows ? `<table class="hmi-table"><tr><th>Time</th><th>Operator action</th><th>Result</th><th>Detail</th></tr>${rows}</table>` : `<p class="h-empty">No operator actions yet. Click a piece of equipment on the overview to open its faceplate.</p>`;
  }

  private bannerHtml(): string {
    const list = this.sortedAlarms();
    if (!list.length) return `<span class="h-quiet">No active alarms</span>`;
    const top = list
      .slice(0, 3)
      .map((a) => `<div class="h-banner-row p${a.prio}${a.acked ? " acked" : ""}"><span class="h-prio p${a.prio}${a.acked ? "" : " blink"}">${a.prio}</span><span class="h-time">${clock(a.since)}</span><span class="h-text">${esc(a.text)}</span>${a.acked ? "" : `<button class="hmi-btn small" data-ack="${esc(a.id)}">Ack</button>`}</div>`)
      .join("");
    const more = list.length > 3 ? `<button class="hmi-link" data-screen="alarms">${list.length - 3} more</button>` : "";
    const ackAll = list.some((a) => !a.acked) ? `<button class="hmi-btn small" data-ack="*">Ack all</button>` : "";
    return `<div class="h-banner-list">${top}</div><div class="h-banner-side">${more}${ackAll}</div>`;
  }

  private object(id: string | undefined): HmiObject | undefined {
    return id ? this.def?.objects.find((o) => o.id === id) : undefined;
  }

  private rowHtml(c: Ctx, r: Row): string {
    let val: string;
    let cls = "";
    if (!r.sig || !c.has(r.sig)) val = "not read by this HMI";
    else if (r.on !== undefined) {
      const v = c.v(r.sig) >= 1;
      val = v ? r.on : r.off ?? "";
      if (v && r.bad) cls = "bad";
    } else val = `${(c.v(r.sig) / (r.scale ?? 1)).toFixed(r.digits ?? 0)} ${r.unit ?? ""}`;
    if (r.sig && c.has(r.sig) && !c.fresh(r.sig)) cls += " stale";
    return `<tr><th>${esc(r.label)}</th><td class="${cls.trim()}">${esc(val)}</td></tr>`;
  }

  private blockedWhy(sim: Sim, c: Ctx, ctl: Control): string | undefined {
    const dev = sim.hmiSource(ctl.sig)?.device ?? sim.site.hmi!.device;
    if (!sim.hmiWritable(ctl.sig)) return `The HMI cannot write this on this site: ${dev} has no point for it, or the HMI is not one of its normal writers.`;
    if (!c.fresh(ctl.sig)) return `No communication with ${dev}. Commands are disabled until it answers again.`;
    return ctl.blocked?.(c);
  }

  private controlHtml(sim: Sim, c: Ctx, o: HmiObject, ctl: Control): string {
    const why = this.blockedWhy(sim, c, ctl);
    const dis = why ? " disabled" : "";
    const reason = why ? `<div class="h-why">${esc(why)}</div>` : "";
    if (ctl.kind === "pair") {
      const cur = c.v(ctl.sig) >= 1 ? 1 : 0;
      const btn = (value: 0 | 1, text: string) => `<button class="hmi-btn${cur === value ? " current" : ""}" data-cmd="${esc(ctl.sig)}" data-value="${value}" data-obj-id="${esc(o.id)}"${dis}>${esc(text)}</button>`;
      let confirm = "";
      if (this.confirm?.sig === ctl.sig) confirm = `<div class="h-confirm"><p>${esc(this.confirm.text)}</p><button class="hmi-btn danger" data-confirm="1">Confirm</button><button class="hmi-btn" data-confirm="0">Cancel</button></div>`;
      return `<div class="h-ctl"><div class="h-ctl-label">${esc(ctl.label)}</div><div class="h-ctl-btns">${btn(1, ctl.one)}${btn(0, ctl.zero)}</div>${reason}${confirm}</div>`;
    }
    const cur = c.has(ctl.sig) ? (c.v(ctl.sig) / ctl.scale).toFixed(ctl.digits) : "";
    return `<div class="h-ctl"><div class="h-ctl-label">${esc(ctl.label)} <span class="h-range">${ctl.min} to ${ctl.max} ${esc(ctl.unit)}</span></div><div class="h-ctl-btns"><input type="number" data-sp="${esc(ctl.sig)}" value="${esc(cur)}" min="${ctl.min}" max="${ctl.max}" step="${1 / 10 ** ctl.digits}" aria-label="${esc(`${o.tag} ${ctl.label}`)}"${dis}><span class="h-unit-text">${esc(ctl.unit)}</span><button class="hmi-btn" data-set="${esc(ctl.sig)}"${dis}>Set</button></div>${reason}</div>`;
  }

  private renderFace(sim: Sim, c: Ctx): void {
    const face = this.el!.querySelector<HTMLElement>("#hmi-face")!;
    const o = this.object(this.selected);
    if (!o) {
      const html = `<div class="h-face-empty"><p><b>Click a piece of equipment</b> to open its faceplate: its values, and the commands the operator can give.</p><p class="h-hint">Grey means normal. Dark equipment is running. Coloured squares and triangles are alarms. Magenta values are stale: the HMI lost contact with the controller.</p></div>`;
      if (this.faceKey !== "empty") {
        face.innerHTML = html;
        this.faceKey = "empty";
      }
      return;
    }
    const rows = o.rows.map((r) => this.rowHtml(c, r)).join("");
    const controls = o.controls.map((ctl) => this.controlHtml(sim, c, o, ctl)).join("");
    const note = o.note?.(c);
    const msg = this.msg ? `<div class="h-msg ${this.msg.ok ? "ok" : "bad"}"><b>${esc(this.msg.text)}</b>${this.msg.detail ? `<div class="h-detail">${esc(this.msg.detail)}</div>` : ""}</div>` : "";
    const key = `${o.id}`;
    if (this.faceKey !== key) {
      face.innerHTML = `<div class="h-face-head"><span><b>${esc(o.tag)}</b> ${esc(o.title)}</span><button class="hmi-x" data-close aria-label="Close the faceplate">×</button></div>
        <table class="h-rows" id="h-rows"></table>
        <div id="h-ctls"></div>
        <div id="h-msg"></div>
        <p class="h-hint" id="h-note"></p>`;
      this.faceKey = key;
    }
    const put = (sel: string, html: string, guardInputs = false) => {
      const n = face.querySelector<HTMLElement>(sel)!;
      if (n.innerHTML === html) return;
      // Do not wipe a number the operator is typing.
      if (guardInputs) {
        const active = document.activeElement as HTMLInputElement | null;
        if (active && n.contains(active) && active.matches("input[data-sp]")) return;
      }
      n.innerHTML = html;
    };
    put("#h-rows", rows);
    put("#h-ctls", controls || `<p class="h-hint">No commands from the HMI.</p>`, true);
    put("#h-msg", msg);
    put("#h-note", esc(note ?? ""));
  }

  // ------------------------------------------------------------ actions

  private select(id: string): void {
    this.selected = this.selected === id ? undefined : id;
    this.confirm = undefined;
    this.msg = undefined;
    this.screen = "overview";
    this.refresh();
  }

  private click(e: Event): void {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-obj], [data-screen], [data-ack], [data-show], [data-cmd], [data-confirm], [data-set], [data-close], [data-goto]");
    if (!t || !this.el?.contains(t)) return;
    const d = t.dataset;
    if (d.goto) return; // handled by the page
    e.preventDefault();
    if (d.obj) return this.select(d.obj);
    if (d.screen) {
      this.screen = d.screen as Screen;
      return this.refresh();
    }
    if (d.ack) {
      for (const a of this.alarms.values()) if (d.ack === "*" || a.id === d.ack) a.acked = true;
      return this.refresh();
    }
    if (d.show) {
      this.screen = "overview";
      this.selected = d.show;
      this.msg = undefined;
      return this.refresh();
    }
    if (d.close !== undefined) {
      this.selected = undefined;
      return this.refresh();
    }
    if (d.cmd) return this.command(d.cmd, Number(d.value));
    if (d.confirm) {
      const pending = this.confirm;
      this.confirm = undefined;
      if (d.confirm === "1" && pending) return this.write(pending.sig, pending.value, pending.action);
      return this.refresh();
    }
    if (d.set) return this.submitSetpoint(d.set);
  }

  private findControl(sig: string): { o: HmiObject; ctl: Control } | undefined {
    const o = this.object(this.selected);
    const ctl = o?.controls.find((x) => x.sig === sig);
    return o && ctl ? { o, ctl } : undefined;
  }

  private command(sig: string, value: number): void {
    const f = this.findControl(sig);
    if (!f || f.ctl.kind !== "pair") return;
    const action = `${f.o.tag} ${f.ctl.label.toLowerCase()} ${(value ? f.ctl.one : f.ctl.zero).toLowerCase()}`;
    if (f.ctl.confirm && f.ctl.confirm.value === value) {
      this.confirm = { sig, value, text: f.ctl.confirm.text, action };
      this.msg = undefined;
      return this.refresh();
    }
    this.write(sig, value, action);
  }

  private submitSetpoint(sig: string): void {
    const f = this.findControl(sig);
    if (!f || f.ctl.kind !== "setpoint") return;
    const ctl = f.ctl;
    const input = this.el?.querySelector<HTMLInputElement>(`input[data-sp="${sig}"]`);
    const value = Number(input?.value);
    const sim = this.getSim();
    let error: string | undefined;
    if (!input || input.value.trim() === "" || !Number.isFinite(value)) error = "Type a number first.";
    else if (value < ctl.min || value > ctl.max) error = `Out of range. The HMI accepts ${ctl.min} to ${ctl.max} ${ctl.unit}.`;
    else error = ctl.check?.(this.ctx(sim), value);
    if (error) {
      this.msg = { ok: false, text: error };
      input?.blur();
      return this.refresh();
    }
    input?.blur();
    this.write(sig, Math.round(value * ctl.scale), `${f.o.tag} ${ctl.label.toLowerCase()} ${value.toFixed(ctl.digits)} ${ctl.unit}`.trim());
  }

  private write(sig: string, raw: number, action: string): void {
    const sim = this.getSim();
    const a = sim.hmiWrite(sig, raw, action);
    const result = a.result.charAt(0).toUpperCase() + a.result.slice(1);
    this.msg = { ok: a.ok, text: `${result}: ${action}`, detail: a.detail };
    this.refresh();
    this.onAction();
  }
}
