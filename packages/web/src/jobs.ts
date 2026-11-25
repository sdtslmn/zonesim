// Jobs: the people who work on a plant. Each job connects the terminal to the
// places that person works from: the operator to the HMI, the network
// engineer to the firewall and switches, the SOC analyst to the console where
// traffic and alerts show up, and the attacker to a foothold outside the plant.

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
  view: "map" | "plant";
  places: Place[];
  quick: QuickCommand[];
}

export const JOB_IDS: JobId[] = ["operator", "network", "soc", "attacker"];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function jobFor(id: JobId, sim: Sim): Job {
  const consolePlace: Place = { target: "console", label: "Console", sub: "management station" };
  const hostPlace = (name: string | undefined, sub?: string): Place[] => {
    const h = name ? sim.net.host(name) : undefined;
    return h ? [{ target: h.name, label: h.name, sub: sub ?? h.description }] : [];
  };
  const fw = sim.infra.firewall.name;
  switch (id) {
    case "operator": {
      const hmi = sim.site.hmi?.host ?? sim.roleHost("hmi")?.name;
      const ews = sim.roleHost("ews")?.name;
      const plc = sim.site.hmi?.device ?? sim.roleHost("plc")?.name ?? "PLC";
      return {
        id,
        label: "Operator",
        blurb: `Run the plant. Watch the Plant view, and read or change the controller from the HMI with modbus.`,
        view: "plant",
        places: [...hostPlace(hmi, "operator HMI"), ...hostPlace(ews, "engineering workstation")],
        quick: [
          { cmd: "plant", label: "Plant status" },
          { cmd: `ssh ${hmi ?? "HMI"} modbus map ${plc}`, label: "Register map" },
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
        ],
      };
    case "soc":
      return {
        id,
        label: "SOC analyst",
        blurb: "Watch what crosses the network and what the IDS sensor raises. A full OT monitoring console comes in the next release.",
        view: "map",
        places: [consolePlace],
        quick: [
          { cmd: "alerts", label: "Alerts" },
          { cmd: "flows", label: "Flows" },
          { cmd: `ssh ${fw} execute log display`, label: "Firewall log" },
          { cmd: "fw log", label: "Blocked traffic" },
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
