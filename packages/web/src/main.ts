// Browser front end. Layout: Labs, Help and Site on the left; the network map
// and the plant on the top right; the terminal docked at the bottom right.
// On phones the panels stack behind a tab bar. Everything runs client-side.

import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Trainer, parseLab, sortLabs, findLab, builtinSite, loadSiteFile, siteCompatible, withSwitchVendor, SWITCH_VENDORS, VERSION, C, DEFAULT_SITE, type Lab, type Site, type SwitchVendor } from "@zonesim/core";
import { LineEditor } from "./line-editor";
import { NetworkMap } from "./map";
import { plantPanel, statusStrip } from "./plant";
import { HmiView } from "./hmi";
import { MonitorView } from "./monitor";
import { helpPanel, HELP_PAGES } from "./help";
import { jobBarHtml, jobFor, whereNow, JOB_IDS, type JobId } from "./jobs";
import { listSites, siteText, isBuiltin, addSite, removeSite, setActiveSite, startSite, templateText, fetchSite, download } from "./sites";

const REPO_URL: string = import.meta.env.VITE_REPO_URL ?? "https://github.com/sdtslmn/zonesim";

// ---------------------------------------------------------------- labs and progress

const rawLabs = import.meta.glob("../../../labs/**/*.yaml", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const labs: Lab[] = sortLabs(
  Object.entries(rawLabs)
    .map(([file, text]) => {
      try {
        return parseLab(text, file);
      } catch (e) {
        console.warn(`Skipping ${file}: ${(e as Error).message}`);
        return undefined;
      }
    })
    .filter((l): l is Lab => !!l),
);

function stored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage may be off; things then last for this tab */
  }
}

const progress = {
  load: (): string[] => stored<string[]>("zonesim.progress", []),
  save: (ids: string[]) => store("zonesim.progress", ids),
};

// ---------------------------------------------------------------- helpers

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Light markdown for lab text: paragraphs, `code`, **bold**. Hard-wrapped lines are joined. */
function md(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((para) => `<p>${inline(para.replace(/\s*\n\s*/g, " ").trim())}</p>`)
    .join("");
}

const inline = (text: string) => esc(text).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- layout

interface LayoutPrefs {
  side: number;
  dock: number;
  folded: boolean;
}

const app = $("app");
const work = $("work");
const dock = $("dock");
const mobile = window.matchMedia("(max-width: 860px)");
const prefs: LayoutPrefs = { side: 420, dock: Math.round(window.innerHeight * 0.38), folded: false, ...stored<Partial<LayoutPrefs>>("zonesim.layout", {}) };

function applyLayout(): void {
  app.style.setProperty("--side-w", `${prefs.side}px`);
  app.style.setProperty("--dock-h", `${prefs.dock}px`);
  dock.classList.toggle("folded", prefs.folded);
  const t = $("dock-toggle");
  t.textContent = prefs.folded ? "▴" : "▾";
  t.setAttribute("aria-label", prefs.folded ? "Unfold the terminal" : "Fold the terminal");
  $("dock-where").textContent = prefs.folded ? "folded, click the arrow to open" : "";
  fitTerminal();
}

function saveLayout(): void {
  store("zonesim.layout", prefs);
}

function unfold(): void {
  if (!prefs.folded) return;
  prefs.folded = false;
  applyLayout();
  saveLayout();
}

/** Drag a separator. move() gets the pointer position; returns nothing. */
function draggable(handle: HTMLElement, move: (e: PointerEvent) => void, keys: (delta: number) => void): void {
  handle.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("dragging");
    const onMove = (ev: PointerEvent) => move(ev);
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("dragging");
      saveLayout();
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  });
  handle.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 80 : 20;
    const d = { ArrowLeft: -step, ArrowUp: step, ArrowRight: step, ArrowDown: -step }[e.key];
    if (d === undefined) return;
    e.preventDefault();
    keys(d);
    saveLayout();
  });
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

draggable(
  $("split-v"),
  (e) => {
    prefs.side = clamp(e.clientX - app.getBoundingClientRect().left, 280, window.innerWidth - 380);
    applyLayout();
  },
  (d) => {
    prefs.side = clamp(prefs.side + d, 280, window.innerWidth - 380);
    applyLayout();
  },
);

draggable(
  $("dock-head"),
  (e) => {
    const r = work.getBoundingClientRect();
    prefs.dock = clamp(r.bottom - e.clientY, 120, r.height - 60);
    prefs.folded = false;
    applyLayout();
  },
  (d) => {
    prefs.dock = clamp(prefs.dock + d, 120, work.getBoundingClientRect().height - 60);
    prefs.folded = false;
    applyLayout();
  },
);

$("dock-toggle").addEventListener("click", () => {
  prefs.folded = !prefs.folded;
  applyLayout();
  saveLayout();
  if (!prefs.folded) term.focus();
});
$("dock-head").addEventListener("dblclick", (e) => {
  if ((e.target as HTMLElement).closest("button")) return;
  prefs.folded = !prefs.folded;
  applyLayout();
  saveLayout();
});

// ---------------------------------------------------------------- terminal

const term = new Terminal({
  convertEol: true,
  cursorBlink: true,
  fontFamily: '"Cascadia Code", Consolas, "DejaVu Sans Mono", monospace',
  fontSize: window.matchMedia("(max-width: 860px)").matches ? 12 : 14,
  scrollback: 5000,
  theme: { background: "#14181f" },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open($("terminal"));

function fitTerminal(): void {
  const el = $("terminal");
  if (el.offsetHeight > 20 && el.offsetWidth > 20) {
    try {
      fit.fit();
    } catch {
      /* not laid out yet */
    }
  }
}
new ResizeObserver(fitTerminal).observe($("terminal"));

// ---------------------------------------------------------------- state

type LeftTab = "labs" | "help" | "site";
type RightTab = "map" | "plant" | "hmi" | "monitor";

const state = {
  left: "labs" as LeftTab,
  labView: "list" as "list" | "lab",
  help: HELP_PAGES[0]?.file ?? "",
  right: "map" as RightTab,
  pane: "left" as "left" | "right",
  checking: false,
  siteMsg: undefined as { kind: "error" | "success" | "info"; html: string } | undefined,
  editorText: "",
  editorOpen: false,
  /** Plant groups open in the Labs tab. */
  openPlants: new Set<string>(),
  job: stored<JobId>("zonesim.job", "network"),
};
if (!JOB_IDS.includes(state.job)) state.job = "network";

const PLANT_KIND: Record<string, string> = {
  "riverside-water": "drinking water",
  "gas-compressor-station": "gas pipeline",
  "metro-line": "metro",
  "data-centre-cooling": "data centre",
};

/** Built-in sites in the order people see them. */
const SITE_ORDER = ["riverside-water", "riverside-segmented", "gas-compressor-station", "data-centre-cooling", "metro-line"];

/** A short description of a site for menus: its plant, and whether it is a built-in. */
function siteKind(site: Site): string {
  if (site.id === "riverside-segmented") return "drinking water, finished design";
  const plant = [site.id, ...site.extends].find((x) => PLANT_KIND[x]);
  const kind = plant ? PLANT_KIND[plant] : site.process.model;
  return isBuiltin(site.id) ? kind : `yours, ${kind}`;
}

function sortedSites() {
  const rank = (id: string) => SITE_ORDER.indexOf(id) + 1 || SITE_ORDER.length + 1;
  return listSites().sort((a, b) => Number(!a.builtin) - Number(!b.builtin) || rank(a.id) - rank(b.id));
}

/** A site by id: a built-in, or one saved in this browser. */
function siteById(id: string): Site | undefined {
  if (isBuiltin(id)) return builtinSite(id);
  const text = siteText(id);
  return text ? loadSiteFile(text).site : undefined;
}

/** Open the plant group of the lab or site in use. */
function openCurrentPlant(): void {
  const site = trainer.session ? trainer.sim.site : trainer.site;
  const id = trainer.lab?.site ?? [site.id, ...site.extends].find((x) => PLANT_KIND[x]) ?? "riverside-water";
  state.openPlants.add(id);
}

const panel = $("panel");
const view = $("view");

// ---------------------------------------------------------------- device brands

/** Switch brands picked in the Site tab: site id to switch name to vendor. */
const brands = stored<Record<string, Record<string, SwitchVendor>>>("zonesim.brands", {});

/** The site with the switch brands picked for it. */
function branded(site: Site): Site {
  let out = site;
  for (const [sw, vendor] of Object.entries(brands[site.id] ?? {})) out = withSwitchVendor(out, sw, vendor);
  return out;
}

const trainer: Trainer = new Trainer({
  labs,
  site: branded(startSite()),
  print: (s) => term.write(s),
  columns: () => term.cols,
  progress,
  onChange: () => {
    if (state.left === "labs") renderSide();
  },
});

const map = new NetworkMap(() => trainer.sim);
const hmi = new HmiView(
  () => trainer.sim,
  () => {
    const slot = $("strip-slot");
    const html = statusStrip(trainer.sim);
    if (slot.innerHTML !== html) slot.innerHTML = html;
  },
);
const monitor = new MonitorView(
  () => trainer.sim,
  () => {
    const slot = $("strip-slot");
    const html = statusStrip(trainer.sim);
    if (slot.innerHTML !== html) slot.innerHTML = html;
  },
);
let busy = false;

const editor = new LineEditor(term, {
  prompt: () => trainer.prompt(),
  continuation: "> ",
  onLine: async (line) => {
    busy = true;
    try {
      await trainer.run(line);
    } catch (e) {
      term.write(C.red(`internal error: ${(e as Error).message}\n`));
      console.error(e);
    }
    if (trainer.shell.exitRequested) {
      trainer.shell.exitRequested = false;
      term.write("You are on the console already. Close the tab to leave.\n");
    }
    busy = false;
    if (trainer.lab && state.left === "labs") state.labView = "lab";
    refreshLive();
    renderJobBar();
    editor.showPrompt();
  },
  onInterrupt: () => {},
  complete: (line) => trainer.complete(line),
});

/** Run a command as if it was typed (for the panel buttons). */
async function runCommand(cmd: string): Promise<void> {
  if (busy) return;
  unfold();
  busy = true;
  term.write(cmd + "\n");
  try {
    await trainer.run(cmd);
  } finally {
    busy = false;
  }
  refreshLive();
  renderJobBar();
  editor.showPrompt();
  term.focus();
}

// ---------------------------------------------------------------- jobs

const jobbar = $("jobbar");

function renderJobBar(): void {
  if (!trainer.session) return;
  const html = jobBarHtml(state.job, trainer.sim, whereNow(trainer.shell));
  if (jobbar.innerHTML !== html) jobbar.innerHTML = html;
}

function selectJob(id: JobId): void {
  state.job = id;
  store("zonesim.job", id);
  const job = jobFor(id, trainer.sim);
  if (state.right !== job.view) {
    state.right = job.view;
    renderTabs();
    renderView();
  }
  renderJobBar();
}

/** Point the terminal at a place: the console, a host or a network device. */
async function connect(target: string): Promise<void> {
  if (busy) return;
  const sh = trainer.shell;
  unfold();
  if (whereNow(sh) === target) {
    term.focus();
    return;
  }
  if (sh.session || sh.stack.length) {
    const was = whereNow(sh);
    sh.session = undefined;
    sh.stack.length = 0;
    term.write(`\n${C.gray(`Left ${was}.`)}\n`);
    editor.showPrompt();
  }
  if (target === "console") {
    renderJobBar();
    term.focus();
    return;
  }
  await runCommand(`ssh ${target}`);
}

jobbar.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-job], [data-place], [data-cmd]");
  if (!el) return;
  if (el.dataset.job) selectJob(el.dataset.job as JobId);
  else if (el.dataset.place) void connect(el.dataset.place);
  else if (el.dataset.cmd) void connect("console").then(() => runCommand(el.dataset.cmd!));
});

function setQuery(changes: Record<string, string | null>): void {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString().replace(/=(&|$)/g, "$1");
  history.replaceState(null, "", s ? `?${s}` : location.pathname);
}

// ---------------------------------------------------------------- tabs

function renderTabs(): void {
  app.dataset.pane = state.pane;
  document.querySelectorAll<HTMLButtonElement>(".tab[data-tab]").forEach((b) => {
    const t = b.dataset.tab!;
    const inMobileBar = !!b.closest(".mobile-tabs");
    const on = inMobileBar ? (state.pane === "left" ? state.left === t : state.right === t) : t === state.left || t === state.right;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  $("site-chip").textContent = `Site: ${trainer.session ? trainer.sim.site.name : trainer.site.name}`;
}

function selectTab(t: string): void {
  if (t === "labs" || t === "help" || t === "site") {
    if (t === "labs" && state.left === "labs" && (state.pane === "left" || !mobile.matches)) state.labView = state.labView === "lab" || !trainer.lab ? "list" : "lab";
    state.left = t;
    state.pane = "left";
    renderSide();
  } else if (t === "map" || t === "plant" || t === "hmi" || t === "monitor") {
    state.right = t;
    state.pane = "right";
    renderView();
  }
  renderTabs();
  requestAnimationFrame(fitTerminal);
}

document.querySelectorAll<HTMLButtonElement>(".tab[data-tab]").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab!)));

// ---------------------------------------------------------------- left panel

function renderSide(): void {
  renderTabs();
  const top = panel.scrollTop;
  if (state.left === "help") panel.innerHTML = helpPanel(state.help);
  else if (state.left === "site") panel.innerHTML = sitePanel();
  else if (state.labView === "lab" && trainer.lab) panel.innerHTML = labPanel();
  else {
    openCurrentPlant();
    panel.innerHTML = labListPanel();
  }
  panel.scrollTop = top;
}

function labListPanel(): string {
  let html = `<h2>Labs</h2><p class="meta">Short exercises on four simulated plants, each checked automatically. ${trainer.done.size} of ${labs.length} done.</p>`;
  const sites = [...new Set(trainer.labs.map((l) => l.site))];
  for (const siteId of sites) {
    const plantLabs = trainer.labs.filter((l) => l.site === siteId);
    const done = plantLabs.filter((l) => trainer.done.has(l.id)).length;
    const open = state.openPlants.has(siteId);
    html += `<details class="plant-group" data-plant="${esc(siteId)}"${open ? " open" : ""}><summary class="lab-plant">${esc(builtinSite(siteId).name)} <span class="meta">${PLANT_KIND[siteId] ?? ""} · ${done} of ${plantLabs.length} done</span></summary>`;
    html += `<p class="meta plant-links"><a href="#" data-action="explore-site" data-id="${esc(siteId)}">Explore this plant</a> in the sandbox, or start with lab 1.</p>`;
    let level = "";
    plantLabs.forEach((l, i) => {
      if (l.level !== level) {
        if (level) html += "</ul>";
        level = l.level;
        html += `<h3>${level}</h3><ul class="lab-list">`;
      }
      const fit = trainer.fits.get(l.id);
      const badge = fit && !fit.ok ? `<span class="badge" title="${esc(fit.problems[0] ?? "")}">on ${esc(builtinSite(l.site).name.split(" ")[0])}</span>` : "";
      html += `<li data-lab="${esc(l.id)}" class="${trainer.lab?.id === l.id ? "current" : ""}" tabindex="0"><span class="${trainer.done.has(l.id) ? "done" : ""}"><b>${i + 1}.</b> ${esc(l.title)}</span><span class="meta">${badge}${l.minutes} min</span></li>`;
    });
    html += "</ul></details>";
  }
  html += `<h3>Or explore freely</h3><p>The <a href="#" data-action="sandbox">sandbox</a> is the plant as found, with no lab. Type <code>help</code> in the terminal for every command, or open the <a href="#" data-goto="help">Help</a> tab.</p>
  <p class="meta">ZoneSim ${VERSION}. The plants, devices and vendors are fictional. <a href="${esc(REPO_URL)}" target="_blank" rel="noopener">Source on GitHub</a>.</p>`;
  return html;
}

function labPanel(): string {
  const lab = trainer.resolved ?? trainer.lab!;
  const plantLabs = trainer.plantLabs(trainer.lab!);
  const i = plantLabs.findIndex((l) => l.id === lab.id);
  const results = trainer.lastResults;
  const complete = !!results && results.every((r) => r.passed);
  const next = trainer.nextLab();
  let html = `<p class="crumbs"><a href="#" data-action="all-labs">← All labs</a></p>
  <p class="meta">${esc(trainer.sim.site.name)} · lab ${i + 1} of ${plantLabs.length} · ${lab.level} · about ${lab.minutes} min · ${esc(lab.topic)}</p>
  <h2>${esc(lab.title)}</h2>
  ${trainer.siteNote ? `<div class="notice info">${esc(trainer.siteNote)}</div>` : ""}
  <div class="intro">${md(lab.intro)}</div>
  <h3>Tasks</h3><ol class="tasks">${lab.tasks.map((t) => `<li>${inline(t)}</li>`).join("")}</ol>
  <div class="actions">
    <button class="btn primary" data-cmd="check">Check my work</button>
    <button class="btn" data-cmd="hint">Hint</button>
    <button class="btn" data-cmd="solution">Solution</button>
    <button class="btn" data-cmd="reset">Reset lab</button>
  </div>`;
  if (results) {
    html += `<ul class="results">${results.map((r) => `<li class="${r.passed ? "ok" : "bad"}">${esc(r.name)}${r.detail && !r.passed ? `<span class="detail">${esc(r.detail)}</span>` : ""}</li>`).join("")}</ul>`;
  }
  if (complete) {
    html += `<div class="notice success"><strong>Lab complete.</strong>${lab.learned ? md(lab.learned) : ""}${lab.refs.length ? `<p class="meta">Related: ${lab.refs.map(esc).join("; ")}</p>` : ""}${next ? `<button class="btn primary" data-cmd="next">Next: ${esc(next.title)}</button>` : `<p>That was the last lab for this plant. Well done. <a href="#" data-action="all-labs">Pick another plant</a>.</p>`}</div>`;
  }
  return html;
}

function sitePanel(): string {
  const site = trainer.site;
  const fits = [...trainer.fits.values()];
  const own = !isBuiltin(site.id);
  let labsHtml: string;
  if (state.checking) labsHtml = `<p class="meta">Checking which labs run on this site…</p>`;
  else if (!fits.length) labsHtml = `<p class="meta">All ${labs.length} labs were written for this site.</p>`;
  else {
    const ok = fits.filter((f) => f.ok).length;
    labsHtml = `<p>${ok} of ${fits.length} labs run on this site.${ok < fits.length ? " The others run on the plant they were written for." : ""}</p>`;
    const bad = fits.filter((f) => !f.ok);
    const rows = `<ul class="results">${bad.map((f) => `<li class="bad">${esc(f.lab.title)}<span class="detail">${esc(f.problems[0] ?? "")}</span></li>`).join("")}</ul>`;
    if (bad.length > 3) labsHtml += `<details class="why"><summary>Why the other ${bad.length} do not fit</summary>${rows}</details>`;
    else if (bad.length) labsHtml += rows;
  }
  const entries = sortedSites();
  const running = trainer.session ? trainer.sim.site : site;
  const elsewhere = running.id !== site.id ? `<div class="notice info">The current lab runs on ${esc(running.name)}. The site you choose here is for the sandbox and for the labs written for its plant.</div>` : "";
  const rows = entries
    .map(
      (e) => `<li class="${e.id === site.id ? "current" : ""}">
      <div><b>${esc(e.name)}</b><div class="meta">${esc(e.id)} · ${e.builtin ? "built in" : "yours, saved in this browser"}</div></div>
      <div class="row-actions">
        ${e.id === site.id ? `<span class="meta">in use</span>` : `<button class="btn small primary" data-action="use-site" data-id="${esc(e.id)}">Use</button>`}
        <button class="btn small" data-action="download-site" data-id="${esc(e.id)}" title="Download the site file">Download</button>
        ${e.builtin ? "" : `<button class="btn small" data-action="edit-site" data-id="${esc(e.id)}">Edit</button><button class="btn small danger" data-action="remove-site" data-id="${esc(e.id)}" title="Delete it from this browser">Delete</button>`}
      </div></li>`,
    )
    .join("");
  const msg = state.siteMsg ? `<div class="notice ${state.siteMsg.kind}" id="site-msg">${state.siteMsg.html}</div>` : "";
  return `<h2>Site</h2>
  ${elsewhere}
  <div class="site-card">
    <div class="site-name">${esc(site.name)}</div>
    <div class="meta">${esc(site.id)}${site.extends.length ? ` · extends ${site.extends.map(esc).join(" → ")}` : ""}${own ? " · yours" : " · built in"}</div>
    ${site.description ? `<p>${esc(site.description)}</p>` : ""}
    <div class="meta">${site.hosts.length} hosts · ${Object.keys(site.devices).length} controllers · ${site.flows.length} data flows · ${esc(site.process.model)} process</div>
  </div>
  <h3>Network devices</h3>
  ${devicesHtml(site)}
  <h3>Labs on this site</h3>
  ${labsHtml}
  <h3>Sites</h3>
  <ul class="site-list">${rows}</ul>
  <h3>Bring your own plant</h3>
  <p>Describe your site in a short YAML file: host names, IP addresses, the Modbus map, setpoints and the traffic it needs. Start from the template. <a href="#" data-help="customize.md">How it works</a>.</p>
  <div class="actions">
    <label class="btn primary">Load a site file<input type="file" accept=".yaml,.yml,.txt,text/yaml" id="site-file" hidden></label>
    <button class="btn" data-action="download-template">Download template</button>
  </div>
  <div class="url-row"><input type="url" id="site-url" placeholder="https://.../my-site.yaml" aria-label="Address of a site file"><button class="btn" data-action="load-url">Load from URL</button></div>
  ${msg}
  <details id="site-editor"${state.editorOpen ? " open" : ""}><summary>Paste or edit a site file</summary>
    <textarea id="site-text" spellcheck="false" rows="16" aria-label="Site file">${esc(state.editorText)}</textarea>
    <div class="actions"><button class="btn primary" data-action="load-text">Check and use</button><button class="btn" data-action="start-template">Start from the template</button></div>
  </details>
  <p class="meta">Site files never leave your browser. To share one, put it online and add <code>?site=</code> and its address to the simulator link.</p>`;
}

const VENDOR_LABEL: Record<string, string> = { hirschmann: "Hirschmann (HiOS)", cisco: "Cisco (IOS)", fortinet: "Fortinet (FortiOS)" };

/** The firewall and switches of a site, with a brand picker for each switch. */
function devicesHtml(site: Site): string {
  const fw = site.network.firewall;
  const rows = [
    `<tr><td><b>${esc(fw.name)}</b><div class="meta">firewall</div></td><td><select disabled aria-label="Brand of ${esc(fw.name)}"><option>${VENDOR_LABEL[fw.vendor]}</option></select></td><td class="meta">${esc(fw.model)}</td></tr>`,
    ...site.network.switches.map(
      (sw) =>
        `<tr><td><b>${esc(sw.name)}</b><div class="meta">switch, ${sw.ports.filter((p) => p.host).length} hosts</div></td><td><select data-brand="${esc(sw.name)}" aria-label="Brand of ${esc(sw.name)}">${SWITCH_VENDORS.map((v) => `<option value="${v}"${v === sw.vendor ? " selected" : ""}>${VENDOR_LABEL[v]}</option>`).join("")}</select></td><td class="meta">${esc(sw.model)}</td></tr>`,
    ),
  ].join("");
  return `<p class="meta">Each device's terminal speaks its brand's command line. Log in from the console with <code>ssh ${esc(fw.name)}</code>, or pick the Network engineer job above the map. Changing a brand restarts the sandbox or the lab.</p>
  <table class="device-table">${rows}</table>
  <p class="meta">Firewall: Fortinet for now. Switches: Hirschmann or Cisco. <a href="#" data-help="devices.md">Device command reference</a>.</p>`;
}

async function setBrand(sw: string, vendor: SwitchVendor): Promise<void> {
  const id = trainer.site.id;
  brands[id] = { ...(brands[id] ?? {}), [sw]: vendor };
  store("zonesim.brands", brands);
  const base = siteById(id);
  if (base) await useSite(base);
}

// ---------------------------------------------------------------- right panel

function renderView(): void {
  if (state.right !== "monitor") monitor.unmount();
  if (state.right === "monitor") {
    map.unmount();
    hmi.unmount();
    if (!(monitor.mounted && view.querySelector("#mon-root"))) {
      view.innerHTML = `<div id="mon-root"></div>`;
      monitor.mount(view.querySelector<HTMLElement>("#mon-root")!);
    } else monitor.refresh();
  } else if (state.right === "map") {
    hmi.unmount();
    if (!(map.mounted && view.querySelector("#map-root"))) {
      view.innerHTML = `<div id="map-root"></div>`;
      map.mount(view.querySelector<HTMLElement>("#map-root")!);
    }
  } else if (state.right === "hmi") {
    map.unmount();
    if (!(hmi.mounted && view.querySelector("#hmi-root"))) {
      view.innerHTML = `<div id="hmi-root"></div>`;
      hmi.mount(view.querySelector<HTMLElement>("#hmi-root")!);
    } else hmi.refresh();
  } else {
    map.unmount();
    hmi.unmount();
    const top = view.scrollTop;
    view.innerHTML = `<div class="plant-view">${plantPanel(trainer.sim)}</div>`;
    view.scrollTop = top;
  }
  const slot = $("strip-slot");
  const html = statusStrip(trainer.sim);
  if (slot.innerHTML !== html) slot.innerHTML = html;
}

/** Update the live parts without rebuilding the panels. */
function refreshLive(): void {
  trainer.sim.advance();
  const slot = $("strip-slot");
  const html = statusStrip(trainer.sim);
  if (slot.innerHTML !== html) slot.innerHTML = html;
  if (state.right === "map") map.refresh();
  else if (state.right === "hmi") hmi.refresh();
  else if (state.right === "monitor") monitor.refresh();
  else renderView();
}

view.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest<HTMLElement>("[data-goto]");
  if (!a) return;
  e.preventDefault();
  selectTab(a.dataset.goto!);
});

setInterval(refreshLive, 500);

// ---------------------------------------------------------------- actions

async function openLab(lab: Lab): Promise<void> {
  if (busy) return;
  busy = true;
  term.write("\n");
  await trainer.startLab(lab);
  busy = false;
  state.left = "labs";
  state.labView = "lab";
  renderSide();
  panel.scrollTop = 0;
  renderView();
  editor.showPrompt();
  if (!mobile.matches) term.focus();
  setQuery({ lab: lab.id.split("-")[0], sandbox: null });
}

async function openSandbox(): Promise<void> {
  if (busy) return;
  busy = true;
  term.write("\n");
  await trainer.startSandbox();
  busy = false;
  state.labView = "list";
  state.right = "map";
  if (mobile.matches) state.pane = "right";
  renderSide();
  renderView();
  editor.showPrompt();
  term.focus();
  setQuery({ lab: null, sandbox: "" });
}

/**
 * Switch to a site: find which of its plant's labs fit it, then restart the
 * current lab on it if the lab belongs to that plant, or open the sandbox.
 */
async function useSite(site: Site): Promise<void> {
  if (busy) return;
  busy = true;
  trainer.setSite(branded(site));
  setActiveSite(site.id);
  state.checking = true;
  renderSide();
  await pause(30);
  if (site.id !== DEFAULT_SITE) await trainer.checkLabs();
  state.checking = false;
  term.write(`\n${C.bold(`Site: ${site.name}`)}\n`);
  state.openPlants.clear();
  const keepLab = trainer.lab && siteCompatible(site, trainer.lab.site);
  if (keepLab) await trainer.startLab(trainer.lab!);
  else {
    await trainer.startSandbox(false);
    term.write(welcome());
    state.labView = "list";
  }
  busy = false;
  map.unmount();
  renderSide();
  renderView();
  renderJobBar();
  editor.showPrompt();
  setQuery({ site: isBuiltin(site.id) && site.id !== DEFAULT_SITE ? site.id : null, lab: keepLab ? trainer.lab!.id.split("-")[0] : null, sandbox: null });
}

/** The line printed on the start page. */
function welcome(): string {
  return `You are on the ${C.bold("console")} of ${C.bold(trainer.site.name)}. Pick a lab on the left, or explore: try ${C.cyan("plant")}, ${C.cyan("hosts")} and ${C.cyan("help")}.\n\n`;
}

/** Back to the start page: the lab list and the sandbox on the chosen site, with a fresh terminal. */
async function goHome(): Promise<void> {
  closeSiteMenu();
  if (busy) return;
  busy = true;
  term.clear();
  term.write(`\r\x1b[2K${C.bold(`ZoneSim ${VERSION}`)}  OT/ICS security training simulator\n${C.gray("A simulated plant. Nothing real is touched.")}\n\n`);
  await trainer.startSandbox(false);
  term.write(welcome());
  busy = false;
  state.left = "labs";
  state.labView = "list";
  state.right = "map";
  state.pane = "left";
  state.siteMsg = undefined;
  state.openPlants.clear();
  map.unmount();
  renderSide();
  panel.scrollTop = 0;
  renderView();
  renderJobBar();
  editor.showPrompt();
  setQuery({ lab: null, sandbox: null });
  if (!mobile.matches) term.focus();
}

// ---------------------------------------------------------------- site menu

const siteMenu = $("site-menu");
const siteChip = $("site-chip");

function siteMenuHtml(): string {
  const running = trainer.session ? trainer.sim.site.id : trainer.site.id;
  const item = (id: string, name: string, kind: string) =>
    `<button class="menu-item${id === running ? " current" : ""}" role="menuitemradio" aria-checked="${id === running}" data-site="${esc(id)}"><span class="check" aria-hidden="true">${id === running ? "✓" : ""}</span><span><span class="menu-name">${esc(name)}</span><span class="meta">${esc(kind)}</span></span></button>`;
  const entries = sortedSites();
  const builtins = entries.filter((e) => e.builtin);
  const yours = entries.filter((e) => !e.builtin);
  const kindOf = (id: string) => {
    const site = siteById(id);
    return site ? siteKind(site) : "has problems, open the Site tab";
  };
  return `<div class="menu-label">Plants</div>${builtins.map((e) => item(e.id, e.name, kindOf(e.id))).join("")}
  ${yours.length ? `<div class="menu-label">Your sites</div>${yours.map((e) => item(e.id, e.name, kindOf(e.id))).join("")}` : ""}
  <div class="menu-sep" role="separator"></div>
  <button class="menu-item plain" role="menuitem" data-menu="load"><span class="check" aria-hidden="true">+</span><span class="menu-name">Load your own site</span></button>
  <button class="menu-item plain" role="menuitem" data-menu="manage"><span class="check" aria-hidden="true"></span><span class="menu-name">Manage sites</span></button>`;
}

function openSiteMenu(): void {
  siteMenu.innerHTML = siteMenuHtml();
  siteMenu.hidden = false;
  siteChip.setAttribute("aria-expanded", "true");
  (siteMenu.querySelector<HTMLElement>(".menu-item.current") ?? siteMenu.querySelector<HTMLElement>(".menu-item"))?.focus();
}

function closeSiteMenu(focusChip = false): void {
  if (siteMenu.hidden) return;
  siteMenu.hidden = true;
  siteChip.setAttribute("aria-expanded", "false");
  if (focusChip) siteChip.focus();
}

siteChip.addEventListener("click", (e) => {
  e.stopPropagation();
  if (siteMenu.hidden) openSiteMenu();
  else closeSiteMenu();
});

siteMenu.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-site],[data-menu]");
  if (!el) return;
  closeSiteMenu();
  if (el.dataset.site) {
    const site = siteById(el.dataset.site);
    if (!site) {
      showSiteMessage("error", `Site ${esc(el.dataset.site)} no longer loads. Edit it to see why.`);
      return;
    }
    state.siteMsg = undefined;
    if (mobile.matches) state.pane = "right";
    void useSite(site);
  } else if (el.dataset.menu === "load") {
    state.left = "site";
    state.pane = "left";
    renderSide();
    panel.querySelector("#site-file")?.closest(".actions")?.scrollIntoView({ block: "center" });
  } else {
    selectTab("site");
    panel.scrollTop = 0;
  }
});

siteMenu.addEventListener("keydown", (e) => {
  const items = [...siteMenu.querySelectorAll<HTMLElement>(".menu-item")];
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === "Escape") {
    e.preventDefault();
    closeSiteMenu(true);
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  } else if (e.key === "Home" || e.key === "End") {
    e.preventDefault();
    items[e.key === "Home" ? 0 : items.length - 1]?.focus();
  } else if (e.key === "Tab") closeSiteMenu();
});

document.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest("#site-menu-wrap")) closeSiteMenu();
});

function showSiteMessage(kind: "error" | "success" | "info", html: string): void {
  state.siteMsg = { kind, html };
  state.left = "site";
  state.pane = "left";
  renderSide();
  panel.querySelector("#site-msg")?.scrollIntoView({ block: "nearest" });
}

const list = (items: string[]) => `<ul>${items.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`;

async function loadText(text: string, from: string): Promise<void> {
  const r = addSite(text);
  if (!r.site) {
    showSiteMessage("error", `<strong>${esc(from)} has ${r.errors.length} problem${r.errors.length === 1 ? "" : "s"}.</strong>${list(r.errors)}<p class="meta">Fix them and load it again. <a href="#" data-help="customize.md">How site files work</a>.</p>`);
    return;
  }
  state.editorText = text;
  await useSite(r.site);
  const fits = [...trainer.fits.values()];
  const ok = fits.filter((f) => f.ok).length;
  showSiteMessage(
    "success",
    `<strong>Loaded ${esc(r.site.name)}.</strong> ${fits.length ? `${ok} of ${fits.length} labs run on it.` : ""}${r.warnings.length ? `<p>Worth a look:</p>${list(r.warnings)}` : ""}`,
  );
}

panel.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-lab],[data-help],[data-goto],[data-cmd],[data-action]");
  if (!el) return;
  if (el.tagName === "A") e.preventDefault();
  if (el.dataset.lab) {
    const lab = labs.find((l) => l.id === el.dataset.lab);
    if (lab) void openLab(lab);
  } else if (el.dataset.help) {
    state.help = el.dataset.help;
    state.left = "help";
    state.pane = "left";
    renderSide();
    panel.scrollTop = 0;
  } else if (el.dataset.goto) {
    selectTab(el.dataset.goto);
  } else if (el.dataset.cmd) {
    void runCommand(el.dataset.cmd);
  } else {
    void siteAction(el.dataset.action!, el.dataset.id);
  }
});

panel.addEventListener("keydown", (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>("[data-lab]");
  if (li && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    li.click();
  }
});

panel.addEventListener("input", (e) => {
  const t = e.target as HTMLElement;
  if (t.id === "site-text") state.editorText = (t as HTMLTextAreaElement).value;
});

panel.addEventListener("toggle", (e) => {
  const el = e.target as HTMLDetailsElement;
  if (el.id === "site-editor") state.editorOpen = el.open;
  const plant = el.dataset?.plant;
  if (plant) {
    if (el.open) state.openPlants.add(plant);
    else state.openPlants.delete(plant);
  }
}, true);

panel.addEventListener("change", (e) => {
  const sel = e.target as HTMLSelectElement;
  if (sel.dataset?.brand) return void setBrand(sel.dataset.brand, sel.value as SwitchVendor);
  const input = e.target as HTMLInputElement;
  if (input.id !== "site-file" || !input.files?.length) return;
  const file = input.files[0];
  if (file.size > 512 * 1024) return showSiteMessage("error", "That file is larger than 512 KB, which is too large for a site file.");
  void file.text().then((text) => loadText(text, file.name));
});

async function siteAction(action: string, id?: string): Promise<void> {
  switch (action) {
    case "sandbox":
      return openSandbox();
    case "explore-site": {
      if (!id || busy) return;
      trainer.lab = undefined;
      if (mobile.matches) state.pane = "right";
      return useSite(builtinSite(id));
    }
    case "all-labs":
      state.labView = "list";
      renderSide();
      panel.scrollTop = 0;
      return;
    case "use-site": {
      const text = id ? siteText(id) : undefined;
      const site = id && isBuiltin(id) ? builtinSite(id) : text ? loadSiteFile(text).site : undefined;
      if (!site) return showSiteMessage("error", `Site ${esc(id ?? "")} no longer loads. Edit it to see why.`);
      state.siteMsg = undefined;
      return useSite(site);
    }
    case "download-site": {
      const text = id ? siteText(id) : undefined;
      if (text) download(`${id}.yaml`, text);
      return;
    }
    case "edit-site": {
      state.editorText = (id && siteText(id)) ?? "";
      state.editorOpen = true;
      renderSide();
      panel.querySelector<HTMLTextAreaElement>("#site-text")?.focus();
      return;
    }
    case "remove-site": {
      if (!id || !confirm(`Delete ${id} from this browser? Download it first if you want to keep it.`)) return;
      const wasActive = trainer.site.id === id;
      removeSite(id);
      state.siteMsg = undefined;
      if (wasActive) return useSite(builtinSite());
      return renderSide();
    }
    case "download-template":
      return download("my-site.yaml", templateText());
    case "start-template":
      state.editorText = templateText();
      state.editorOpen = true;
      return renderSide();
    case "load-text":
      if (!state.editorText.trim()) return showSiteMessage("info", "Paste a site file into the box first, or start from the template.");
      return loadText(state.editorText, "The site file");
    case "load-url": {
      const url = panel.querySelector<HTMLInputElement>("#site-url")?.value.trim() ?? "";
      if (!url) return showSiteMessage("info", "Type the address of a site file first.");
      const r = await fetchSite(url);
      if (!r.text) return showSiteMessage("error", esc(r.error ?? "Could not load it."));
      return loadText(r.text, url.split("/").pop() || "The file");
    }
  }
}

$("nav-home").addEventListener("click", () => void goHome());
$("brand").addEventListener("click", (e) => {
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  void goHome();
});
($("nav-repo") as HTMLAnchorElement).href = REPO_URL;
mobile.addEventListener("change", () => {
  renderTabs();
  requestAnimationFrame(fitTerminal);
});
window.addEventListener("resize", () => {
  prefs.side = clamp(prefs.side, 280, Math.max(280, window.innerWidth - 380));
  applyLayout();
});

// ---------------------------------------------------------------- start

applyLayout();
term.write(`${C.bold(`ZoneSim ${VERSION}`)}  OT/ICS security training simulator\n${C.gray("A simulated plant. Nothing real is touched.")}\n\n`);
void (async () => {
  const params = new URLSearchParams(location.search);
  const siteParam = params.get("site");
  if (siteParam) {
    if (isBuiltin(siteParam)) trainer.setSite(branded(builtinSite(siteParam)));
    else {
      const r = await fetchSite(siteParam);
      const loaded = r.text ? addSite(r.text) : undefined;
      if (loaded?.site) {
        trainer.setSite(branded(loaded.site));
        setActiveSite(loaded.site.id);
        state.siteMsg = { kind: "success", html: `<strong>Loaded ${esc(loaded.site.name)}</strong> from the link.` };
      } else {
        state.siteMsg = { kind: "error", html: `<strong>Could not load the site in the link.</strong>${r.error ? `<p>${esc(r.error)}</p>` : list(loaded?.errors ?? [])}` };
        state.left = "site";
      }
    }
  }
  if (trainer.site.id !== DEFAULT_SITE) {
    state.checking = true;
    renderSide();
    await trainer.checkLabs();
    state.checking = false;
  }
  const deepLab = params.get("lab");
  const startLab = deepLab ? findLab(trainer.labs, deepLab) : undefined;
  if (startLab) {
    await trainer.startLab(startLab);
    state.labView = "lab";
  } else {
    await trainer.startSandbox(false);
    term.write(welcome());
  }
  if (params.has("sandbox")) state.right = "map";
  renderSide();
  renderView();
  renderJobBar();
  editor.showPrompt();
  if (!mobile.matches) term.focus();
})();
