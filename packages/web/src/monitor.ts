// The Monitor tab: the SOC analyst's OT monitoring console. It shows what the
// passive IDS sensor sees: the assets it found, who talks to whom, the alerts
// it raised and the raw traffic, and it lets the analyst switch the sensor
// between learning and protecting, acknowledge alerts, and learn anomalies
// that turn out to be planned changes.

import { clock, ago, attackText, attackUrl, linkText, FC_NAMES, WRITE_FCS, type Alert, type Asset, type Sim } from "@zonesim/core";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

type Tab = "dashboard" | "alerts" | "assets" | "links" | "traffic";
const TABS: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "alerts", label: "Alerts" },
  { id: "assets", label: "Assets" },
  { id: "links", label: "Links" },
  { id: "traffic", label: "Traffic" },
];

const SEV_ORDER = ["critical", "high", "medium", "low"] as const;
const sevChip = (s: string) => `<span class="sev sev-${s}">${s}</span>`;

export class MonitorView {
  private el?: HTMLElement;
  private tab: Tab = "dashboard";
  private alertId?: string;
  private assetName?: string;
  private alertState: "open" | "all" = "open";
  private alertKind: "any" | "rule" | "anomaly" | "process" = "any";
  private linksView: "seen" | "baseline" = "seen";
  private linksNewOnly = false;
  private traffic = { plant: false, writes: false, blocks: true, host: "" };
  private last: Record<string, string> = {};
  private msg?: string;

  constructor(
    private getSim: () => Sim,
    /** Called after the analyst changed something, so the rest of the page can refresh. */
    private onAction: () => void,
  ) {}

  get mounted(): boolean {
    return !!this.el?.isConnected;
  }

  mount(el: HTMLElement): void {
    this.el = el;
    this.last = {};
    el.innerHTML = `<div class="mon">
      <div class="mon-head" id="mon-head"></div>
      <div class="mon-tools" id="mon-tools"></div>
      <div class="mon-main" id="mon-main">
        <div class="mon-content" id="mon-content"></div>
        <aside class="mon-detail" id="mon-detail" aria-live="polite"></aside>
      </div>
    </div>`;
    el.addEventListener("click", (e) => this.click(e));
    el.addEventListener("change", (e) => this.change(e));
    el.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement;
      if ((e.key === "Enter" || e.key === " ") && t.matches("tr[data-alert], tr[data-asset], li[data-alert], li[data-asset]")) {
        e.preventDefault();
        t.click();
      }
    });
    this.refresh();
  }

  unmount(): void {
    this.el = undefined;
  }

  /** Open the console on one alert, for example from a link elsewhere. */
  showAlert(id: string): void {
    this.tab = "alerts";
    this.alertId = id;
    this.refresh();
  }

  refresh(): void {
    if (!this.el) return;
    const sim = this.getSim();
    if (this.alertId && !sim.alerts.some((a) => a.id === this.alertId)) this.alertId = undefined;
    if (this.assetName && !sim.net.host(this.assetName)) this.assetName = undefined;
    this.put("mon-head", this.headHtml(sim));
    this.put("mon-tools", this.toolsHtml(sim));
    this.put("mon-content", this.contentHtml(sim));
    const detail = this.detailHtml(sim);
    this.put("mon-detail", detail);
    this.el.querySelector<HTMLElement>("#mon-main")!.dataset.detail = detail ? "1" : "0";
  }

  private put(id: string, html: string): void {
    if (!this.el || this.last[id] === html) return;
    this.last[id] = html;
    const n = this.el.querySelector<HTMLElement>(`#${id}`);
    if (n) n.innerHTML = html;
  }

  // ------------------------------------------------------------ actions

  private click(e: Event): void {
    const target = e.target as HTMLElement;
    if (target.closest("a[target]")) return; // ATT&CK links open in a new tab
    const t = target.closest<HTMLElement>("[data-mon-tab], [data-alert], [data-asset], [data-act], [data-opt]");
    if (!t) return;
    if (target.closest('a[href="#"]')) e.preventDefault();
    const sim = this.getSim();
    this.msg = undefined;
    if (t.dataset.monTab) {
      this.tab = t.dataset.monTab as Tab;
    } else if (t.dataset.alert) {
      this.tab = "alerts";
      this.alertId = t.dataset.alert;
    } else if (t.dataset.asset) {
      this.tab = "assets";
      this.assetName = t.dataset.asset;
    } else if (t.dataset.opt) {
      const [k, v] = t.dataset.opt.split("=");
      if (k === "state") this.alertState = v as "open" | "all";
      else if (k === "kind") this.alertKind = v as typeof this.alertKind;
      else if (k === "links") this.linksView = v as "seen" | "baseline";
    } else if (t.dataset.act) {
      const act = t.dataset.act;
      try {
        if (act === "mode") {
          sim.sensor.mode = sim.sensor.mode === "protecting" ? "learning" : "protecting";
          this.msg = sim.sensor.mode === "learning" ? "The sensor is learning: whatever it sees now becomes normal. Switch back once the plant runs as it should." : "The sensor is protecting: anything outside the baseline raises an alert.";
          sim.emit();
        } else if (act === "ack" && t.dataset.id) {
          const a = sim.alerts.find((x) => x.id === t.dataset.id);
          if (a) a.acked = true;
          sim.emit();
        } else if (act === "learn" && t.dataset.id) {
          sim.learnAlert(t.dataset.id);
          this.msg = `${t.dataset.id} learned as normal.`;
        } else if (act === "forget" && t.dataset.id) {
          const b = sim.sensor.forget(Number(t.dataset.id));
          if (b) this.msg = `Forgot ${b.src} → ${b.dst} ${b.service}. It raises a New link alert the next time it is seen.`;
          sim.emit();
        } else if (act === "traffic" && t.dataset.host) {
          this.tab = "traffic";
          this.traffic = { ...this.traffic, host: t.dataset.host, plant: true };
        } else if (act === "close") {
          this.alertId = undefined;
          this.assetName = undefined;
        }
      } catch (err) {
        this.msg = (err as Error).message;
      }
      this.onAction();
    }
    this.refresh();
  }

  private change(e: Event): void {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const k = t.dataset.tf;
    if (k === "plant" || k === "writes" || k === "blocks") this.traffic[k] = (t as HTMLInputElement).checked;
    else if (k === "host") this.traffic.host = t.value;
    else if (t.dataset.lf === "new") this.linksNewOnly = (t as HTMLInputElement).checked;
    else return;
    this.refresh();
  }

  // ------------------------------------------------------------ head

  private headHtml(sim: Sim): string {
    const s = sim.sensor;
    const open = sim.alerts.filter((a) => !a.acked);
    const outside = s.links().filter((l) => !l.learned || l.newFcs.length).length;
    const counts: Record<Tab, string> = {
      dashboard: "",
      alerts: open.length ? `<span class="mon-count${open.some((a) => a.severity === "critical" || a.severity === "high") ? " hot" : ""}">${open.length}</span>` : "",
      assets: `<span class="mon-count">${s.assets(sim.net.hosts).length}</span>`,
      links: outside ? `<span class="mon-count hot" title="outside the baseline">${outside} new</span>` : "",
      traffic: "",
    };
    const sw = sim.infra.switches[0]?.name;
    const learning = s.mode === "learning";
    return `<div class="mon-bar">
      <div class="mon-id"><b>OT monitor</b><span>IDS sensor${sw ? ` on a mirror port of ${esc(sw)}` : ""}, watching what the firewall lets through</span></div>
      <div class="mon-mode">
        <span class="mon-pill ${learning ? "learning" : "protecting"}" title="${learning ? "Everything the sensor sees becomes normal" : "Anything outside the baseline raises an alert"}">${learning ? "Learning" : "Protecting"}</span>
        <button class="mon-btn" data-act="mode">${learning ? "Stop learning" : "Start learning"}</button>
      </div>
    </div>
    <nav class="mon-tabs" role="tablist" aria-label="Monitor">${TABS.map((t) => `<button role="tab" aria-selected="${t.id === this.tab}" class="${t.id === this.tab ? "active" : ""}" data-mon-tab="${t.id}">${t.label}${counts[t.id]}</button>`).join("")}</nav>
    ${this.msg ? `<p class="mon-msg">${esc(this.msg)}</p>` : ""}`;
  }

  private toolsHtml(sim: Sim): string {
    const chip = (opt: string, label: string, on: boolean) => `<button class="chip${on ? " active" : ""}" data-opt="${opt}" aria-pressed="${on}">${label}</button>`;
    switch (this.tab) {
      case "alerts":
        return `${chip("state=open", "Open", this.alertState === "open")}${chip("state=all", "All", this.alertState === "all")}<span class="mon-sep"></span>${chip("kind=any", "Every source", this.alertKind === "any")}${chip("kind=rule", "Rules", this.alertKind === "rule")}${chip("kind=anomaly", "Anomalies", this.alertKind === "anomaly")}${chip("kind=process", "Process", this.alertKind === "process")}`;
      case "links":
        return `${chip("links=seen", "Seen on the network", this.linksView === "seen")}${chip("links=baseline", "Baseline", this.linksView === "baseline")}${this.linksView === "seen" ? `<label class="mon-check"><input type="checkbox" data-lf="new"${this.linksNewOnly ? " checked" : ""}> Only outside the baseline</label>` : ""}`;
      case "traffic": {
        const hosts = sim.net.hosts.map((h) => `<option value="${esc(h.name)}"${h.name === this.traffic.host ? " selected" : ""}>${esc(h.name)}</option>`).join("");
        return `<label class="mon-check">Host <select data-tf="host"><option value="">any</option>${hosts}</select></label>
          <label class="mon-check"><input type="checkbox" data-tf="plant"${this.traffic.plant ? " checked" : ""}> Plant polling</label>
          <label class="mon-check"><input type="checkbox" data-tf="writes"${this.traffic.writes ? " checked" : ""}> Only Modbus writes</label>
          <label class="mon-check"><input type="checkbox" data-tf="blocks"${this.traffic.blocks ? " checked" : ""}> Firewall blocks</label>`;
      }
      default:
        return "";
    }
  }

  // ------------------------------------------------------------ content

  private contentHtml(sim: Sim): string {
    switch (this.tab) {
      case "dashboard":
        return this.dashboardHtml(sim);
      case "alerts":
        return this.alertsHtml(sim);
      case "assets":
        return this.assetsHtml(sim);
      case "links":
        return this.linksHtml(sim);
      case "traffic":
        return this.trafficHtml(sim);
    }
  }

  private dashboardHtml(sim: Sim): string {
    const s = sim.sensor;
    const open = sim.alerts.filter((a) => !a.acked);
    const assets = s.assets(sim.net.hosts);
    const links = s.links();
    const outside = links.filter((l) => !l.learned || l.newFcs.length);
    const learnedLater = s.baseline.filter((b) => b.how !== "commissioning").length;
    const sevs = SEV_ORDER.map((sv) => `<span class="mon-sevcount">${sevChip(sv)} ${open.filter((a) => a.severity === sv).length}</span>`).join("");
    const kpis = `<div class="mon-kpis">
      <div class="mon-kpi"><span class="mon-kpi-label">Open alerts</span><b>${open.length}</b><div class="mon-sevs">${sevs}</div></div>
      <div class="mon-kpi"><span class="mon-kpi-label">Assets</span><b>${assets.length}</b><span class="mon-kpi-sub">${assets.filter((a) => !a.known).length ? `<span class="bad">${assets.filter((a) => !a.known).length} new</span>` : "all known"}</span></div>
      <div class="mon-kpi"><span class="mon-kpi-label">Links seen</span><b>${links.length}</b><span class="mon-kpi-sub">${outside.length ? `<span class="bad">${outside.length} outside the baseline</span>` : "all in the baseline"}</span></div>
      <div class="mon-kpi"><span class="mon-kpi-label">Baseline</span><b>${s.baseline.length}</b><span class="mon-kpi-sub">${learnedLater ? `<span class="warn">${learnedLater} learned since the start</span>` : "links, from commissioning"}</span></div>
    </div>`;

    const latest = open.slice().reverse().slice(0, 6);
    const latestHtml = latest.length
      ? `<ul class="mon-list">${latest.map((a) => `<li data-alert="${a.id}" tabindex="0">${sevChip(a.severity)}<span class="mon-list-main">${esc(a.title)}${a.count > 1 ? ` <span class="meta">x${a.count}</span>` : ""}</span><span class="meta">${esc(a.src ?? "")} · ${clock(a.lastT)}</span></li>`).join("")}</ul>`
      : `<p class="mon-empty">No open alerts.</p>`;

    const bySrc = new Map<string, Alert[]>();
    for (const a of open) if (a.src && a.source === "ids") bySrc.set(a.src, [...(bySrc.get(a.src) ?? []), a]);
    const rank = (list: Alert[]) => Math.min(...list.map((a) => SEV_ORDER.indexOf(a.severity)));
    const sources = [...bySrc.entries()].sort((a, b) => rank(a[1]) - rank(b[1]) || b[1].length - a[1].length);
    const sourcesHtml = sources.length
      ? `<ul class="mon-list">${sources.map(([name, list]) => `<li data-asset="${esc(name)}" tabindex="0">${sevChip(SEV_ORDER[rank(list)])}<span class="mon-list-main"><b>${esc(name)}</b> ${esc(assets.find((x) => x.name === name)?.type ?? "")}</span><span class="meta">${list.length} alert${list.length === 1 ? "" : "s"}</span></li>`).join("")}</ul>`
      : `<p class="mon-empty">No host is raising IDS alerts.</p>`;

    return `${kpis}<div class="mon-grid">
      <section class="mon-card"><h4>Latest alerts</h4>${latestHtml}</section>
      <section class="mon-card"><h4>Hosts behind the alerts</h4>${sourcesHtml}</section>
      <section class="mon-card"><h4>Traffic in the last minute</h4>${this.trafficBars(sim)}</section>
    </div>`;
  }

  /** One series, one colour: what crossed the network in the last 60 seconds, by kind. */
  private trafficBars(sim: Sim): string {
    const recent = sim.events.filter((e) => sim.t - e.t <= 60);
    const ok = recent.filter((e) => e.allowed);
    const isWrite = (fc?: number) => fc !== undefined && WRITE_FCS.includes(fc);
    const rows: [string, number, string][] = [
      ["Modbus reads", ok.filter((e) => e.service === "modbus" && !isWrite(e.fc)).length, "plant polling and reads"],
      ["Modbus writes", ok.filter((e) => e.service === "modbus" && isWrite(e.fc)).length, "commands and setpoint changes"],
      ["Web (http, https)", ok.filter((e) => e.service === "http" || e.service === "https").length, "historian, reports, SCADA sync"],
      ["Remote access (rdp, ssh)", ok.filter((e) => e.service === "rdp" || e.service === "ssh").length, "people logging in"],
      ["Other", ok.filter((e) => e.service === "icmp").length, "ping"],
      ["Blocked by the firewall", recent.filter((e) => !e.allowed).length, "not seen by the sensor, from the firewall log"],
    ];
    const max = Math.max(1, ...rows.map((r) => r[1]));
    return `<table class="mon-bars"><tbody>${rows
      .map(([label, n, why]) => `<tr title="${esc(`${label}: ${n} in the last minute, ${why}`)}"><th scope="row">${esc(label)}</th><td><span class="mon-bar-track"><span class="mon-bar-fill" style="width:${(n / max) * 100}%"></span></span></td><td class="num">${n}</td></tr>`)
      .join("")}</tbody></table>`;
  }

  private filteredAlerts(sim: Sim): Alert[] {
    return sim.alerts
      .filter((a) => this.alertState === "all" || !a.acked)
      .filter((a) => this.alertKind === "any" || (this.alertKind === "process" ? a.source === "process" : a.source === "ids" && (this.alertKind === "anomaly") === !!a.anomaly))
      .slice()
      .reverse();
  }

  private alertsHtml(sim: Sim): string {
    const list = this.filteredAlerts(sim);
    if (!list.length) return `<p class="mon-empty">${this.alertState === "open" ? "No open alerts. Try All to see the ones already handled." : "No alerts yet."}</p>`;
    const rows = list
      .map((a) => {
        const state = a.learned ? "learned" : a.acked ? "acked" : "open";
        return `<tr data-alert="${a.id}" tabindex="0" class="${a.id === this.alertId ? "sel" : ""}${a.acked ? " done" : ""}"><td>${sevChip(a.severity)}</td><td class="mono">${a.id}</td><td class="mono">${clock(a.lastT)}</td><td class="wrap">${esc(a.title)}${a.count > 1 ? ` <span class="meta">x${a.count}</span>` : ""}</td><td>${esc(a.src ?? "-")}</td><td>${a.source === "process" ? "process" : a.anomaly ? "anomaly" : "rule"}</td><td>${state}</td></tr>`;
      })
      .join("");
    return `<table class="mon-table"><thead><tr><th>Severity</th><th>ID</th><th>Time</th><th>Alert</th><th>From</th><th>Kind</th><th>State</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  private assetsHtml(sim: Sim): string {
    const open = sim.alerts.filter((a) => !a.acked);
    const rows = sim.sensor
      .assets(sim.net.hosts)
      .map((a) => {
        const n = open.filter((x) => x.src === a.name || x.dst === a.name).length;
        const id = a.identity ? `${a.identity.vendor} ${a.identity.product}` : sim.devices.has(a.name) ? `<span class="meta">not identified yet</span>` : esc(a.os ?? "-");
        return `<tr data-asset="${esc(a.name)}" tabindex="0" class="${a.name === this.assetName ? "sel" : ""}"><td><b>${esc(a.name)}</b>${a.known ? "" : ` <span class="tag-new">new</span>`}</td><td class="mono">${a.ip}</td><td class="wrap">${esc(a.type)}</td><td class="wrap">${a.identity ? esc(id) : id}</td><td class="mono">${esc(a.identity?.revision ?? "-")}</td><td>${esc(a.zone)}</td><td>${a.lastT !== undefined ? ago(sim.t - a.lastT) : `<span class="meta">not yet</span>`}</td><td>${n ? `<span class="mon-count hot">${n}</span>` : ""}</td></tr>`;
      })
      .join("");
    return `<table class="mon-table"><thead><tr><th>Name</th><th>IP</th><th>Type</th><th>Vendor and model, or OS</th><th>Firmware</th><th>Zone</th><th>Last seen</th><th>Alerts</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  private linksHtml(sim: Sim): string {
    const s = sim.sensor;
    if (this.linksView === "baseline") {
      const rows = s.baseline
        .map((b) => {
          const how = b.how === "commissioning" ? `<span class="meta">commissioning</span>` : `<span class="warn">${b.how === "alert" ? "from an alert" : "learning"} at ${clock(b.t ?? 0)}</span>`;
          return `<tr><td class="mono">${b.id}</td><td>${esc(b.src)}</td><td>${esc(b.dst)}</td><td>${b.service}</td><td class="mono">${b.service === "modbus" ? (b.anyFc ? "any" : b.fcs.join(", ") || "none") : "-"}</td><td>${how}</td><td><button class="mon-btn small" data-act="forget" data-id="${b.id}" title="Forget this link: it alerts again the next time it is seen">Forget</button></td></tr>`;
        })
        .join("");
      return `<p class="mon-note">What the sensor treats as normal. It learned most of it while it was commissioned, from the plant's polling and data flows. Links learned later are marked: check them if the sensor was left learning.</p>
        <table class="mon-table"><thead><tr><th>N</th><th>From</th><th>To</th><th>Service</th><th>Function codes</th><th>Learned</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
    }
    let list = s.links().sort((a, b) => Number(a.learned && !a.newFcs.length) - Number(b.learned && !b.newFcs.length) || b.lastT - a.lastT);
    if (this.linksNewOnly) list = list.filter((l) => !l.learned || l.newFcs.length);
    if (!list.length) return `<p class="mon-empty">${this.linksNewOnly ? "Every link the sensor has seen is in the baseline." : "The sensor has seen no traffic yet."}</p>`;
    const rows = list
      .map((l) => {
        const status = !l.learned ? `<span class="tag-new">new link</span>` : l.newFcs.length ? `<span class="tag-new">new fc ${l.newFcs.join(", ")}</span>` : `<span class="meta">baseline</span>`;
        const fcs = l.fcs.map((f) => `<span title="${esc(FC_NAMES[f] ?? "")}" class="${WRITE_FCS.includes(f) ? "fc-write" : ""}">${f}</span>`).join(", ");
        return `<tr><td><a href="#" data-asset="${esc(l.src)}">${esc(l.src)}</a></td><td><a href="#" data-asset="${esc(l.dst)}">${esc(l.dst)}</a></td><td>${l.service}</td><td class="mono">${fcs || "-"}</td><td class="num">${l.packets}</td><td>${ago(sim.t - l.lastT)}</td><td>${status}</td></tr>`;
      })
      .join("");
    return `<table class="mon-table"><thead><tr><th>From</th><th>To</th><th>Service</th><th>Function codes</th><th>Packets</th><th>Last</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  private trafficHtml(sim: Sim): string {
    const f = this.traffic;
    const list = sim.events
      .filter((e) => f.plant || !e.background)
      .filter((e) => f.blocks || e.allowed)
      .filter((e) => !f.writes || (e.service === "modbus" && e.fc !== undefined && WRITE_FCS.includes(e.fc)))
      .filter((e) => !f.host || e.src === f.host || e.dst === f.host)
      .slice(-150)
      .reverse();
    if (!list.length) return `<p class="mon-empty">No matching traffic yet.${f.plant ? "" : " Tick Plant polling to see the plant's own traffic."}</p>`;
    const rows = list
      .map((e) => {
        const what = e.detail ?? (e.fc !== undefined ? `${FC_NAMES[e.fc] ?? "function code"} (fc ${e.fc})` : "");
        const verdict = !e.allowed ? `<span class="bad" title="${esc(e.reason)}">blocked${e.conduit ? ` at ${esc(e.conduit)}` : ""}</span>` : !e.delivered ? `<span class="meta" title="${esc(e.reason)}">no answer</span>` : `<span class="ok">seen</span>`;
        const write = e.service === "modbus" && e.fc !== undefined && WRITE_FCS.includes(e.fc);
        return `<tr class="${e.allowed ? "" : "blocked"}"><td class="mono">${clock(e.t)}</td><td><a href="#" data-asset="${esc(e.src)}">${esc(e.src)}</a></td><td><a href="#" data-asset="${esc(e.dst)}">${esc(e.dst)}</a></td><td>${e.service}</td><td class="wrap${write ? " fc-write" : ""}">${esc(what)}</td><td>${verdict}</td><td class="meta">${e.background ? "plant" : "you"}</td></tr>`;
      })
      .join("");
    return `<table class="mon-table"><thead><tr><th>Time</th><th>From</th><th>To</th><th>Service</th><th>What</th><th>Result</th><th>By</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // ------------------------------------------------------------ detail pane

  private detailHtml(sim: Sim): string {
    if (this.tab === "alerts" && this.alertId) {
      const a = sim.alerts.find((x) => x.id === this.alertId);
      return a ? this.alertDetail(sim, a) : "";
    }
    if (this.tab === "assets" && this.assetName) {
      const a = sim.sensor.assets(sim.net.hosts).find((x) => x.name === this.assetName);
      return a ? this.assetDetail(sim, a) : `<div class="mon-d-head"><b>${esc(this.assetName)}</b><button class="icon" data-act="close" aria-label="Close">×</button></div><p class="mon-empty">The sensor has not seen ${esc(this.assetName)} on the network.</p>`;
    }
    return "";
  }

  private hostLine(sim: Sim, name: string): string {
    const h = sim.net.host(name);
    return h ? `<a href="#" data-asset="${esc(h.name)}">${esc(h.name)}</a> <span class="meta">${h.ip}, zone ${esc(h.zone)}</span>` : esc(name);
  }

  private alertDetail(sim: Sim, a: Alert): string {
    const state = a.learned ? "learned as normal" : a.acked ? "acknowledged" : "open";
    const attack = a.attack?.length ? `<dt>ATT&amp;CK</dt><dd>${a.attack.map((id) => `<a href="${attackUrl(id)}" target="_blank" rel="noopener" class="mon-attack">${esc(attackText(id))}</a>`).join(" ")}</dd>` : "";
    const related = sim.events
      .filter((e) => a.src && e.src === a.src && (!a.dst || e.dst === a.dst) && !e.background)
      .slice(-8)
      .reverse();
    const relatedHtml = related.length
      ? `<h5>Related traffic</h5><ul class="mon-mini">${related.map((e) => `<li><span class="mono">${clock(e.t)}</span> ${esc(e.src)} → ${esc(e.dst)} ${e.service}${e.detail ? `: ${esc(e.detail)}` : e.fc !== undefined ? ` fc ${e.fc}` : ""} ${e.allowed ? "" : `<span class="bad">blocked</span>`}</li>`).join("")}</ul>`
      : "";
    const anomaly = a.anomaly?.length ? `<h5>Outside the baseline</h5><ul class="mon-mini">${a.anomaly.map((l) => `<li>${esc(linkText(l))}</li>`).join("")}</ul>` : "";
    const buttons = [
      !a.acked ? `<button class="mon-btn primary" data-act="ack" data-id="${a.id}">Acknowledge</button>` : "",
      a.anomaly?.length && !a.acked ? `<button class="mon-btn" data-act="learn" data-id="${a.id}" title="Add what it saw to the baseline and close the alert">Learn as normal</button>` : "",
      a.src ? `<button class="mon-btn" data-act="traffic" data-host="${esc(a.src)}">Traffic from ${esc(a.src)}</button>` : "",
    ].join("");
    return `<div class="mon-d-head">${sevChip(a.severity)}<b>${esc(a.title)}</b><button class="icon" data-act="close" aria-label="Close">×</button></div>
      <dl class="mon-dl">
        <dt>Alert</dt><dd class="mono">${a.id}, ${state}</dd>
        <dt>When</dt><dd>${clock(a.t)}${a.lastT !== a.t ? ` to ${clock(a.lastT)}` : ""}, ${a.count} time${a.count === 1 ? "" : "s"}</dd>
        <dt>Source</dt><dd>${a.source === "process" ? "the process" : a.anomaly ? "IDS sensor, anomaly" : "IDS sensor, rule"}</dd>
        ${a.src ? `<dt>From</dt><dd>${this.hostLine(sim, a.src)}</dd>` : ""}
        ${a.dst ? `<dt>To</dt><dd>${this.hostLine(sim, a.dst)}</dd>` : ""}
        ${attack}
      </dl>
      <p>${esc(a.detail)}</p>
      ${a.advice ? `<div class="mon-advice"><h5>What to check</h5><p>${esc(a.advice.replace("ids learn ID", "Learn as normal"))}</p></div>` : ""}
      ${anomaly}${relatedHtml}
      <div class="mon-actions">${buttons}</div>
      <p class="meta">Terminal: <code>alerts show ${a.id}</code>${a.anomaly ? `, <code>ids learn ${a.id}</code>` : ""}</p>`;
  }

  private assetDetail(sim: Sim, a: Asset): string {
    const open = sim.alerts.filter((x) => !x.acked && (x.src === a.name || x.dst === a.name));
    const links = sim.sensor
      .links()
      .filter((l) => l.src === a.name || l.dst === a.name)
      .sort((x, y) => y.lastT - x.lastT)
      .slice(0, 10);
    const id = a.identity
      ? `<dt>Vendor</dt><dd>${esc(a.identity.vendor)}</dd><dt>Model</dt><dd>${esc(a.identity.product)}</dd><dt>Firmware</dt><dd class="mono">${esc(a.identity.revision)}</dd><dt>Identified</dt><dd>${a.identity.t === undefined ? "while the sensor was commissioned" : `on the wire at ${clock(a.identity.t)}, from a device identification reply (fc 43)`}</dd>`
      : sim.devices.has(a.name)
        ? `<dt>Identity</dt><dd>not seen yet. The sensor learns it when someone reads device identification (fc 43).</dd>`
        : "";
    return `<div class="mon-d-head"><b>${esc(a.name)}</b>${a.known ? "" : `<span class="tag-new">new</span>`}<button class="icon" data-act="close" aria-label="Close">×</button></div>
      <dl class="mon-dl">
        <dt>Type</dt><dd>${esc(a.type)}</dd>
        <dt>IP</dt><dd class="mono">${a.ip}</dd>
        <dt>Zone</dt><dd>${esc(a.zone)}</dd>
        ${id}
        ${a.os ? `<dt>OS</dt><dd>${esc(a.os)}</dd>` : ""}
        <dt>Serves</dt><dd>${a.serves.join(", ") || "-"}</dd>
        <dt>Uses</dt><dd>${a.uses.join(", ") || "-"}</dd>
        <dt>Peers</dt><dd>${a.peers.map((p) => `<a href="#" data-asset="${esc(p)}">${esc(p)}</a>`).join(", ") || "-"}</dd>
        <dt>Traffic</dt><dd>${a.packets} packets${a.lastT !== undefined ? `, last ${ago(sim.t - a.lastT)}` : ""}</dd>
      </dl>
      ${open.length ? `<h5>Open alerts</h5><ul class="mon-list">${open.map((x) => `<li data-alert="${x.id}" tabindex="0">${sevChip(x.severity)}<span class="mon-list-main">${esc(x.title)}</span><span class="meta">${x.id}</span></li>`).join("")}</ul>` : ""}
      ${links.length ? `<h5>Links</h5><ul class="mon-mini">${links.map((l) => `<li>${esc(l.src)} → ${esc(l.dst)} ${l.service}${l.fcs.length ? ` fc ${l.fcs.join(",")}` : ""} ${!l.learned || l.newFcs.length ? `<span class="tag-new">new</span>` : ""}</li>`).join("")}</ul>` : ""}
      <div class="mon-actions"><button class="mon-btn" data-act="traffic" data-host="${esc(a.name)}">Traffic of ${esc(a.name)}</button></div>
      <p class="meta">Terminal: <code>assets ${esc(a.name)}</code></p>`;
  }
}
