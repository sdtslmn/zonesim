// Browser front end: a panel on the left (labs, network map, plant) and the
// terminal on the right. Everything runs client-side on the same engine as
// the CLI.

import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Trainer, parseLab, sortLabs, findLab, VERSION, C, type Lab } from "@zonesim/core";
import { LineEditor } from "./line-editor";
import { NetworkMap } from "./map";
import { plantPanel, statusStrip } from "./plant";

const REPO_URL: string = import.meta.env.VITE_REPO_URL ?? "https://github.com/sdtslmn/zonesim";

// ---------------------------------------------------------------- labs

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

const PROGRESS_KEY = "zonesim.progress";
const progress = {
  load(): string[] {
    try {
      return JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? "[]") as string[];
    } catch {
      return [];
    }
  },
  save(ids: string[]): void {
    try {
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(ids));
    } catch {
      /* storage may be off; progress then lasts for this tab */
    }
  },
};

// ---------------------------------------------------------------- helpers

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Light markdown: paragraphs, `code`, **bold**. Hard-wrapped lines are joined. */
function md(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((para) => {
      const html = esc(para.replace(/\s*\n\s*/g, " ").trim())
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      return `<p>${html}</p>`;
    })
    .join("");
}

const inline = (text: string) => esc(text).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

// ---------------------------------------------------------------- terminal

const term = new Terminal({
  convertEol: true,
  cursorBlink: true,
  fontFamily: '"Cascadia Code", Consolas, "DejaVu Sans Mono", monospace',
  fontSize: 14,
  scrollback: 5000,
  theme: { background: "#14181f" },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("terminal")!);
fit.fit();
new ResizeObserver(() => fit.fit()).observe(document.getElementById("terminal")!);

type View = "labs" | "lab" | "map" | "plant";
let view: View = "labs";
const panel = document.getElementById("panel")!;
const layout = document.getElementById("layout")!;

const trainer: Trainer = new Trainer({
  labs,
  print: (s) => term.write(s),
  columns: () => term.cols,
  progress,
  onChange: () => {
    if (view === "lab" || view === "labs") renderPanel();
  },
});

const map = new NetworkMap(() => trainer.sim);
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
    refreshLive();
    editor.showPrompt();
  },
  onInterrupt: () => {},
  complete: (line) => trainer.complete(line),
});

/** Run a command as if it was typed (for the panel buttons). */
async function runCommand(cmd: string): Promise<void> {
  if (busy) return;
  busy = true;
  term.write(cmd + "\n");
  try {
    await trainer.run(cmd);
  } finally {
    busy = false;
  }
  refreshLive();
  editor.showPrompt();
  term.focus();
}

// ---------------------------------------------------------------- panel

function setNav(): void {
  const active: Record<string, boolean> = {
    "nav-labs": view === "labs" || (view === "lab" && !!trainer.lab),
    "nav-map": view === "map",
    "nav-plant": view === "plant",
    "nav-sandbox": false,
  };
  for (const [id, on] of Object.entries(active)) document.getElementById(id)!.classList.toggle("active", on);
  layout.classList.toggle("wide", view === "map");
}

function renderPanel(): void {
  setNav();
  if (view !== "map") map.unmount();
  if (view === "map") return renderMap();
  if (view === "plant") return renderPlant();
  if (view === "lab" && trainer.lab) return renderLab();
  return renderLabList();
}

function renderLabList(): void {
  let html = `<h2>Labs</h2><p class="meta">Short exercises on a simulated water treatment plant. Each one is checked automatically. ${trainer.done.size}/${labs.length} done.</p>`;
  let level = "";
  trainer.labs.forEach((l, i) => {
    if (l.level !== level) {
      if (level) html += "</ul>";
      level = l.level;
      html += `<h3>${level}</h3><ul class="lab-list">`;
    }
    html += `<li data-lab="${esc(l.id)}" class="${trainer.lab?.id === l.id ? "current" : ""}"><span class="${trainer.done.has(l.id) ? "done" : ""}"><b>${i + 1}.</b> ${esc(l.title)}</span><span class="meta">${l.minutes} min</span></li>`;
  });
  html += `</ul><h3>Or explore freely</h3><p>The <a href="#" id="go-sandbox">sandbox</a> is the plant as found, with a flat network. Type <code>help</code> in the terminal for every command.</p>
  <p class="meta">ZoneSim ${VERSION}. The plant, devices and vendor are fictional. <a href="${esc(REPO_URL)}" target="_blank" rel="noopener">Source on GitHub</a>.</p>`;
  panel.innerHTML = html;
  panel.querySelectorAll<HTMLElement>("[data-lab]").forEach((li) =>
    li.addEventListener("click", () => {
      const lab = labs.find((l) => l.id === li.dataset.lab)!;
      void openLab(lab);
    }),
  );
  panel.querySelector("#go-sandbox")?.addEventListener("click", (e) => {
    e.preventDefault();
    void openSandbox();
  });
}

function renderLab(): void {
  const lab = trainer.lab!;
  const i = trainer.labs.indexOf(lab);
  const results = trainer.lastResults;
  const complete = !!results && results.every((r) => r.passed);
  const next = trainer.nextLab();
  let html = `<div id="strip-slot">${statusStrip(trainer.sim)}</div>
  <p class="meta">Lab ${i + 1} of ${labs.length} · ${lab.level} · about ${lab.minutes} min · ${esc(lab.topic)}</p>
  <h2>${esc(lab.title)}</h2>
  <div class="intro">${md(lab.intro)}</div>
  <h3>Tasks</h3><ol class="tasks">${lab.tasks.map((t) => `<li>${inline(t)}</li>`).join("")}</ol>
  <div class="actions">
    <button class="btn primary" id="btn-check">Check my work</button>
    <button class="btn" id="btn-hint">Hint</button>
    <button class="btn" id="btn-solution">Solution</button>
    <button class="btn" id="btn-reset">Reset lab</button>
  </div>`;
  if (results) {
    html += `<ul class="results">${results.map((r) => `<li class="${r.passed ? "ok" : "bad"}">${esc(r.name)}${r.detail && !r.passed ? `<span class="detail">${esc(r.detail)}</span>` : ""}</li>`).join("")}</ul>`;
  }
  if (complete) {
    html += `<div class="notice success"><strong>Lab complete.</strong>${lab.learned ? md(lab.learned) : ""}${lab.refs.length ? `<p class="meta">Related: ${lab.refs.map(esc).join("; ")}</p>` : ""}${next ? `<button class="btn primary" id="btn-next">Next: ${esc(next.title)}</button>` : "<p>That was the last lab. Well done.</p>"}</div>`;
  }
  html += `<p class="meta tip">Tip: open the <a href="#" id="go-map">network map</a> beside the terminal to watch traffic as you work.</p>`;
  panel.innerHTML = html;
  const on = (id: string, fn: () => void) => panel.querySelector(`#${id}`)?.addEventListener("click", fn);
  on("btn-check", () => void runCommand("check"));
  on("btn-hint", () => void runCommand("hint"));
  on("btn-solution", () => void runCommand("solution"));
  on("btn-reset", () => void runCommand("reset"));
  on("btn-next", () => void runCommand("next"));
  panel.querySelector("#go-map")?.addEventListener("click", (e) => {
    e.preventDefault();
    view = "map";
    renderPanel();
  });
}

function renderMap(): void {
  if (map.mounted && panel.querySelector("#map-root")) return;
  panel.innerHTML = `<div id="strip-slot">${statusStrip(trainer.sim)}</div><h2>Network map</h2><div id="map-root"></div>`;
  map.mount(panel.querySelector<HTMLElement>("#map-root")!);
}

function renderPlant(): void {
  const top = panel.scrollTop;
  panel.innerHTML = `<h2>Riverside water treatment plant</h2>${plantPanel(trainer.sim)}`;
  panel.scrollTop = top;
}

/** Update the live parts of the panel without rebuilding it. */
function refreshLive(): void {
  trainer.sim.advance();
  const slot = panel.querySelector<HTMLElement>("#strip-slot");
  if (slot) {
    const html = statusStrip(trainer.sim);
    if (slot.innerHTML !== html) slot.innerHTML = html;
  }
  if (view === "map") map.refresh();
  if (view === "plant") renderPlant();
}

setInterval(refreshLive, 500);

async function openLab(lab: Lab): Promise<void> {
  if (busy) return;
  busy = true;
  term.write("\n");
  await trainer.startLab(lab);
  busy = false;
  view = "lab";
  renderPanel();
  editor.showPrompt();
  term.focus();
  history.replaceState(null, "", `?lab=${lab.id.split("-")[0]}`);
}

async function openSandbox(): Promise<void> {
  if (busy) return;
  busy = true;
  term.write("\n");
  await trainer.startSandbox();
  busy = false;
  view = "map";
  renderPanel();
  editor.showPrompt();
  term.focus();
  history.replaceState(null, "", "?sandbox");
}

document.getElementById("nav-labs")!.addEventListener("click", () => {
  // From another view, go back to the current lab; on the lab, show the list.
  if (view === "lab") view = "labs";
  else if (view === "labs") view = trainer.lab ? "lab" : "labs";
  else view = trainer.lab ? "lab" : "labs";
  renderPanel();
});
document.getElementById("nav-map")!.addEventListener("click", () => {
  view = "map";
  renderPanel();
});
document.getElementById("nav-plant")!.addEventListener("click", () => {
  view = "plant";
  renderPanel();
});
document.getElementById("nav-sandbox")!.addEventListener("click", () => void openSandbox());
(document.getElementById("nav-repo") as HTMLAnchorElement).href = REPO_URL;

// ---------------------------------------------------------------- start

term.write(`${C.bold(`ZoneSim ${VERSION}`)}  OT/ICS security training simulator\n${C.gray("A simulated water treatment plant. Nothing real is touched.")}\n\n`);
void (async () => {
  const params = new URLSearchParams(location.search);
  const deepLab = params.get("lab");
  const startLab = deepLab ? findLab(trainer.labs, deepLab) : undefined;
  if (startLab) {
    await trainer.startLab(startLab);
    view = "lab";
  } else {
    await trainer.startSandbox(false);
    term.write(`You are on the ${C.bold("console")}. Pick a lab on the left, or explore: try ${C.cyan("plant")}, ${C.cyan("hosts")} and ${C.cyan("help")}.\n\n`);
    view = params.has("sandbox") ? "map" : "labs";
  }
  renderPanel();
  editor.showPrompt();
  term.focus();
})();
