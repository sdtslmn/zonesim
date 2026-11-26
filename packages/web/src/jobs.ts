// Jobs: the people who work on a plant. Each job connects the terminal to the
// places that person works from: the operator to the HMI, the network
// engineer to the firewall and switches, the SOC analyst to the OT monitoring
// console, and the attacker to a foothold outside the plant.

import { cliName, type Sim } from "@zonesim/core";

export type JobId = "operator" | "network" | "soc" | "attacker";

export interface Place {
  /** What ssh connects to, or "console". */
  target: string;
  label: string;
  sub: string;
}

export interface QuickCommand {
  cmd: string;
  label: string;
}

export interface Job {
  id: JobId;
  label: string;
  blurb: string;
  view: "map" | "plant" | "hmi" | "monitor";
  places: Place[];
  quick: QuickCommand[];
}

export const JOB_IDS: JobId[] = ["operator", "network", "soc", "attacker"];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A button to lose the main control centre, or to bring it back, on sites with a backup centre. */
function takeoverQuick(sim: Sim): QuickCommand[] {
  const sb = sim.site.standby;
  if (!sb) return [];
  return sim.takeover ? [{ cmd: "takeover end", label: `${sb.centre} back` }] : [{ cmd: "takeover start", label: `${sb.centre} lost: take over` }];
}

export function jobFor(id: JobId, sim: Sim): Job {
  const consolePlace: Place = { target: "console", label: "Console", sub: "management station" };
  const hostPlace = (name: string | undefined, sub?: string): Place[] => {
    const h = name ? sim.net.host(name) : undefined;
    return h ? [{ target: h.name, label: h.name, sub: sub ?? h.description }] : [];
  };
  const fw = sim.infra.firewall.name;
  switch (id) {
    case "operator": {
      const hmi = sim.site.hmi ? sim.hmiHost : sim.roleHost("hmi")?.name;
      const ews = sim.roleHost("ews")?.name;
      const plc = sim.site.hmi?.device ?? sim.roleHost("plc")?.name ?? "PLC";
      return {
        id,
        label: "Operator",
        blurb: `Run the plant from the HMI screen: click equipment to start, stop and change setpoints. The terminal can work from the HMI host too.`,
        view: "hmi",
        places: [...hostPlace(hmi, sim.takeover ? `operator HMI at the ${sim.site.standby?.backupName ?? "backup"}` : "operator HMI"), ...(sim.takeover && sim.net.host(ews ?? "")?.down ? [] : hostPlace(ews, "engineering workstation"))],
        quick: [
          { cmd: "plant", label: "Plant status" },
          { cmd: `ssh ${hmi ?? "HMI"} modbus map ${plc}`, label: "Register map" },
          ...takeoverQuick(sim),
        ],
      };
    }
    case "network":
      return {
        id,
        label: "Network engineer",
        blurb: "Build the zones and conduits on the real devices: VLANs on the switches, policies on the firewall.",
        view: "map",
        places: [consolePlace, ...sim.infra.devices.map((d) => ({ target: d.name, label: d.name, sub: `${d.kind === "firewall" ? "firewall" : "switch"}, ${cliName(d)}` }))],
        quick: [
          { cmd: "devices", label: "Devices" },
          { cmd: "hosts -o wide", label: "Hosts and ports" },
          { cmd: "report", label: "Design review" },
          ...takeoverQuick(sim),
        ],
      };
    case "soc":
      return {
        id,
        label: "SOC analyst",
        blurb: "Watch the plant from the OT monitoring console: the assets the IDS sensor found, who talks to whom, and the alerts it raises. Tell attacks from planned changes.",
        view: "monitor",
        places: [consolePlace],
        quick: [
          { cmd: "ids", label: "Sensor" },
          { cmd: "alerts", label: "Alerts" },
          { cmd: "assets", label: "Assets" },
          { cmd: "ids links --new", label: "New links" },
          { cmd: `ssh ${fw} execute log display`, label: "Firewall log" },
        ],
      };
    case "attacker": {
      const outside = sim.net.hosts.filter((h) => h.kind === "external" || h.kind === "it");
      return {
        id,
        label: "Attacker",
        blurb: "Start from a foothold outside the plant and find out what the network lets you reach. Then switch jobs and close the gaps.",
        view: "map",
        places: outside.map((h) => ({ target: h.name, label: h.name, sub: h.description })),
        quick: outside[0] ? [{ cmd: `ssh ${outside[0].name} nmap ${sim.roleHost("plc")?.ip.split(".").slice(0, 3).join(".") ?? "10.0.0"}.0/24`, label: "Scan the control network" }] : [],
      };
    }
  }
}

/** Where the terminal is now: a device, a host, or the console. */
export function whereNow(shell: { session?: { device: { name: string } }; host?: { name: string } }): string {
  return shell.session?.device.name ?? shell.host?.name ?? "console";
}

export function jobBarHtml(current: JobId, sim: Sim, here: string): string {
  const job = jobFor(current, sim);
  const tabs = JOB_IDS.map((id) => {
    const j = jobFor(id, sim);
    return `<button class="job${id === current ? " active" : ""}" role="tab" aria-selected="${id === current}" data-job="${id}">${esc(j.label)}</button>`;
  }).join("");
  const places = job.places
    .map((p) => `<button class="place${p.target === here ? " here" : ""}" data-place="${esc(p.target)}" title="${esc(p.target === "console" ? "Back to the console" : `ssh ${p.target}`)}"><b>${esc(p.label)}</b><span>${esc(p.sub)}</span></button>`)
    .join("");
  const quick = job.quick.map((q) => `<button class="quick" data-cmd="${esc(q.cmd)}" title="${esc(q.cmd)}">${esc(q.label)}</button>`).join("");
  return `<div class="jobs" role="tablist" aria-label="Your job">${tabs}</div>
  <div class="job-body">
    <p class="job-blurb">${esc(job.blurb)}</p>
    <div class="job-row">${places ? `<span class="job-label">Terminal on</span>${places}` : ""}${quick ? `<span class="job-label">Run</span>${quick}` : ""}</div>
  </div>`;
}
