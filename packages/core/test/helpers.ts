import { Sim, MemoryFS, createShell, type IO, type Shell } from "../src/index.js";

/** A sandbox with time that only moves when told to. */
export function sandbox(): { sim: Sim; shell: Shell; fs: MemoryFS; run: (cmd: string) => Promise<{ code: number; out: string; err: string }> } {
  const sim = new Sim({ clock: () => 0 });
  const fs = new MemoryFS();
  const shell = createShell(sim, fs);
  sim.settle(4);
  const run = async (cmd: string) => {
    let out = "";
    let err = "";
    const io: IO = { stdout: (t) => (out += t), stderr: (t) => (err += t), sleep: async (ms) => sim.settle(ms / 1000) };
    const code = await shell.exec(cmd, io);
    const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    return { code, out: plain(out), err: plain(err) };
  };
  return { sim, shell, fs, run };
}

export const ZONES = [
  "zone create enterprise --sl 1",
  "zone create dmz --sl 2",
  "zone create operations --sl 2",
  "zone create control --sl 3",
  "zone create safety --sl 3",
  "zone add enterprise corp-pc",
  "zone add dmz hist-dmz jump-01",
  "zone add operations historian",
  "zone add control hmi-01 ews-01 plc-1",
  "zone add safety sis-1",
  "zone delete site",
];
