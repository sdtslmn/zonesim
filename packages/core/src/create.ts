// Builds a shell with every simulator command registered.

import { Shell } from "./shell.js";
import type { Sim } from "./sim.js";
import type { FileSystem } from "./fs.js";
import { registerBasic } from "./commands/basic.js";
import { registerConsole } from "./commands/console.js";
import { registerHostCommands } from "./commands/hostcmds.js";

export function createShell(sim: Sim, fs: FileSystem): Shell {
  const shell = new Shell(sim, fs);
  registerBasic(shell);
  registerConsole(shell);
  registerHostCommands(shell);
  return shell;
}
