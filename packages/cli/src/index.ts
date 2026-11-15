#!/usr/bin/env node
// ZoneSim in the terminal: an interactive console with labs, plus a few
// non-interactive modes for scripts and CI (-c, validate-labs).

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import * as readline from "node:readline";
import { Trainer, LabSession, MemoryFS, parseLab, sortLabs, findLab, VERSION, C, type Lab, type IO } from "@zonesim/core";

const here = dirname(fileURLToPath(import.meta.url));
const LABS_DIR = process.env.ZONESIM_LABS ?? join(here, "..", "..", "..", "labs");

function yamlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...yamlFiles(p));
    else if (name.endsWith(".yaml") || name.endsWith(".yml")) out.push(p);
  }
  return out;
}

function loadLabs(): Lab[] {
  const labs: Lab[] = [];
  for (const file of yamlFiles(LABS_DIR)) {
    try {
      labs.push(parseLab(readFileSync(file, "utf8"), file));
    } catch (e) {
      console.error(C.yellow(`Skipping ${file}: ${(e as Error).message}`));
    }
  }
  return sortLabs(labs);
}

const PROGRESS_FILE = process.env.ZONESIM_PROGRESS ?? join(homedir(), ".zonesim", "progress.json");

const progress = {
  load(): string[] {
    try {
      return JSON.parse(readFileSync(PROGRESS_FILE, "utf8")) as string[];
    } catch {
      return [];
    }
  },
  save(ids: string[]): void {
    try {
      mkdirSync(dirname(PROGRESS_FILE), { recursive: true });
      writeFileSync(PROGRESS_FILE, JSON.stringify(ids, null, 2));
    } catch {
      /* progress is optional */
    }
  },
};

const USAGE = `ZoneSim ${VERSION}: an OT/ICS security training simulator

Usage:
  zonesim                     interactive console (sandbox)
  zonesim lab <n|id>          start at a lab, e.g. zonesim lab b01
  zonesim -c "<commands>"     run commands in a fresh sandbox and exit
  zonesim validate-labs       check that every lab is solved by its own solution
  zonesim --version
`;

async function validateLabs(labs: Lab[]): Promise<number> {
  let failed = 0;
  for (const lab of labs) {
    const problems: string[] = [];
    const fs = new MemoryFS();
    const s = new LabSession(lab, fs, { clock: () => 0 });
    const setupErrors = await s.setup();
    problems.push(...setupErrors.map((e) => `setup: ${e}`));
    const before = await s.check();
    if (before.every((r) => r.passed)) problems.push("all checks pass before the solution is applied");
    for (const line of lab.solution) {
      let err = "";
      const io: IO = { stdout: () => {}, stderr: (t) => (err += t), sleep: async (ms) => s.sim.settle(ms / 1000) };
      const code = await s.shell.exec(line, io);
      // A step with a comment may fail on purpose ("# times out, as it should").
      if (code !== 0 && !line.includes("#")) problems.push(`solution step failed: ${line}\n      ${err.trim()}`);
    }
    s.sim.settle(2);
    const after = await s.check();
    for (const r of after.filter((x) => !x.passed)) problems.push(`check fails after the solution: ${r.name} (${r.detail ?? ""})`);
    if (problems.length) {
      failed++;
      console.log(`${C.red("✘")} ${lab.id}`);
      for (const p of problems) console.log(`    ${p}`);
    } else console.log(`${C.green("✔")} ${lab.id}  ${C.gray(`${after.length} checks`)}`);
  }
  console.log(failed ? C.red(`\n${failed} of ${labs.length} labs have problems`) : C.green(`\nAll ${labs.length} labs are solvable by their solutions`));
  return failed ? 1 : 0;
}

async function runCommands(script: string): Promise<number> {
  const t: Trainer = new Trainer({ labs: loadLabs(), print: (s) => process.stdout.write(s), sleep: async (ms: number) => t.sim.settle(ms / 1000) });
  await t.startSandbox(false);
  return t.run(script);
}

async function interactive(startLab?: string): Promise<void> {
  const labs = loadLabs();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 500,
    completer: (line: string) => {
      const opts = trainer.complete(line);
      const word = line.split(/\s+/).pop() ?? "";
      return [opts, word];
    },
  });
  const trainer: Trainer = new Trainer({ labs, print: (s) => process.stdout.write(s), progress, columns: () => process.stdout.columns ?? 80 });
  console.log(`${C.bold(`ZoneSim ${VERSION}`)}  OT/ICS security training simulator. ${C.gray("Simulated plant, nothing real is touched.")}`);
  if (startLab) {
    const lab = findLab(trainer.labs, startLab);
    if (!lab) console.log(C.yellow(`No lab matches "${startLab}". Starting the sandbox.`));
    if (lab) await trainer.startLab(lab);
    else await trainer.startSandbox();
  } else {
    await trainer.startSandbox(false);
    console.log(`You are on the ${C.bold("console")}. Try ${C.cyan("plant")}, ${C.cyan("hosts")} and ${C.cyan("help")}, or start the guided labs with ${C.cyan("labs")}.\n`);
  }

  const ask = () => {
    rl.setPrompt(trainer.prompt());
    rl.prompt();
  };
  // Lines are queued and run one at a time, so pasted or piped input keeps its order.
  const queue: string[] = [];
  let running = false;
  let closing = false;
  const work = async () => {
    if (running) return;
    running = true;
    while (queue.length) {
      const line = queue.shift()!;
      try {
        await trainer.run(line);
      } catch (e) {
        console.error(C.red(`internal error: ${(e as Error).stack ?? e}`));
      }
      if (trainer.shell.exitRequested) {
        queue.length = 0;
        closing = true;
        rl.close();
        break;
      }
      if (queue.length) {
        rl.setPrompt(trainer.prompt());
        process.stdout.write(trainer.prompt() + queue[0] + "\n");
      }
    }
    running = false;
    if (!closing) ask();
  };
  rl.on("line", (line) => {
    queue.push(line);
    void work();
  });
  rl.on("SIGINT", () => {
    process.stdout.write("^C\n");
    ask();
  });
  rl.on("close", () => {
    // Input ended (for example a piped script): finish what is queued first.
    const finish = () => {
      if (running || queue.length) return setTimeout(finish, 20);
      console.log("Bye.");
      process.exit(0);
    };
    closing = true;
    finish();
  });
  ask();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--version" || args[0] === "-v") {
    console.log(VERSION);
    return;
  }
  if (args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE);
    return;
  }
  if (args[0] === "validate-labs") {
    process.exit(await validateLabs(loadLabs()));
  }
  if (args[0] === "-c") {
    process.exit(await runCommands(args.slice(1).join(" ")));
  }
  if (args[0] === "lab") {
    await interactive(args[1]);
    return;
  }
  await interactive();
}

void main();
