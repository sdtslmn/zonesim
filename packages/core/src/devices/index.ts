import type { Sim } from "../sim.js";
import type { NetDevice } from "../infra.js";
import type { DeviceSession } from "./session.js";
import { FortiosSession } from "./fortios.js";
import { HiosSession } from "./hios.js";
import { IosSession } from "./ios.js";

export type { DeviceSession } from "./session.js";

/** Open a terminal session on a network device, in its vendor's command line. */
export function openSession(sim: Sim, device: NetDevice): DeviceSession {
  if (device.kind === "firewall") return new FortiosSession(sim, device);
  return device.vendor === "cisco" ? new IosSession(sim, device) : new HiosSession(sim, device);
}

/** What the vendor CLI is called, for banners and help. */
export function cliName(device: NetDevice): string {
  if (device.kind === "firewall") return "FortiOS";
  return device.vendor === "cisco" ? "Cisco IOS" : "Hirschmann HiOS";
}

export function vendorName(device: NetDevice): string {
  return device.vendor === "fortinet" ? "Fortinet" : device.vendor === "cisco" ? "Cisco" : "Hirschmann";
}
