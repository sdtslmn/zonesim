#!/usr/bin/env node
// ZoneSim checker for the terminal and CI. The simulator itself runs in the
// browser; this tool checks site files and labs before you share them.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSiteFile, builtinSite, builtinSiteIds, validateLabsOnSite, parseLab, sortLabs, VERSION, C, stripAnsi, siteCompatible, type Lab, type Site } from "@zonesim/core";

const here = dirname(fileURLToPath(import.meta.url));

// Plain output when piped or when NO_COLOR is set.
if (!process.stdout.isTTY || process.env.NO_COLOR) {
  const plain = (f: (...a: unknown[]) => void) => (...a: unknown[]) => f(...a.map((x) => (typeof x === "string" ? stripAnsi(x) : x)));
  console.log = plain(console.log);
  console.error = plain(console.error);
}
const LABS_DIR = process.env.ZONESIM_LABS ?? join(here, "..", "..", "..", "labs");

const USAGE = `ZoneSim ${VERSION}: checks site files and labs for the ZoneSim OT/ICS security simulator.
The simulator runs in the browser: https://sdtslmn.github.io/zonesim/

Usage:
  zonesim validate SITE.yaml...    check site files, and which labs run on each
  zonesim validate-labs            check that every lab is solved by its own solution
  zonesim --version | --help

Options:
  --labs DIR    labs folder (default: the labs folder of this repo, or $ZONESIM_LABS)
  --quiet       print only problems

Exit code 0 means everything passed, 1 means a problem was found.
`;

function yamlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return yamlFiles(p);
    return name.endsWith(".yaml") || name.endsWith(".yml") ? [p] : [];
  });
}

function loadLabs(dir: string): { labs: Lab[]; errors: string[] } {
  const labs: Lab[] = [];
  const errors: string[] = [];
  for (const file of yamlFiles(dir)) {
    try {
      labs.push(parseLab(readFileSync(file, "utf8"), file));
    } catch (e) {
      errors.push(`${file}: ${(e as Error).message}`);
    }
  }
  return { labs: sortLabs(labs), errors };
}

async function reportLabs(labs: Lab[], site: Site, quiet: boolean): Promise<{ ok: number; total: number; lines: string[] }> {
  const fits = await validateLabsOnSite(labs.filter((l) => siteCompatible(site, l.site)), site);
  const lines: string[] = [];
  for (const f of fits) {
    if (f.ok) {
      if (!quiet) lines.push(`  ${C.green("ok")}    ${f.lab.id}  ${C.dim(`${f.checks} checks`)}`);
    } else {
      lines.push(`  ${C.yellow("skip")}  ${f.lab.id}  ${f.problems[0]}`);
      for (const p of f.problems.slice(1, 3)) lines.push(`        ${C.dim(p)}`);
    }
  }
  return { ok: fits.filter((f) => f.ok).length, total: fits.length, lines };
}

async function validateSites(files: string[], labsDir: string, quiet: boolean): Promise<number> {
  if (!files.length) {
    console.error("validate needs at least one site file, for example: zonesim validate my-site.yaml");
    return 1;
  }
  const { labs, errors: labErrors } = loadLabs(labsDir);
  for (const e of labErrors) console.error(C.yellow(`Skipping lab ${e}`));
  let failed = 0;
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      console.error(`${C.red("✗")} ${file}: ${(e as Error).message}`);
      failed++;
      continue;
    }
    const r = loadSiteFile(text);
    if (!r.site) {
      failed++;
      console.log(`${C.red("✗")} ${file}: ${r.errors.length} problem${r.errors.length === 1 ? "" : "s"}`);
      for (const e of r.errors) console.log(`  ${e}`);
      continue;
    }
    const s = r.site;
    const chain = s.extends.length ? `, extends ${s.extends.join(" → ")}` : "";
    console.log(`${C.green("✓")} ${file}: ${s.name} (${s.id}${chain}), ${s.hosts.length} hosts, ${Object.keys(s.devices).length} controllers, ${s.flows.length} data flows`);
    for (const w of r.warnings ?? []) console.log(`  ${C.yellow("note")}  ${w}`);
    if (labs.some((l) => siteCompatible(s, l.site))) {
      const rep = await reportLabs(labs, s, quiet);
      console.log(`  Labs that run on this site: ${rep.ok} of ${rep.total}.${rep.ok < rep.total ? " The others run on the site they were written for." : ""}`);
      for (const l of rep.lines) console.log(l);
    }
  }
  return failed ? 1 : 0;
}

async function validateAllLabs(labsDir: string, quiet: boolean): Promise<number> {
  const { labs, errors } = loadLabs(labsDir);
  for (const e of errors) console.log(`${C.red("✗")} ${e}`);
  if (!labs.length) {
    console.error(`No labs found in ${labsDir}`);
    return 1;
  }
  let failed = errors.length;
  for (const id of builtinSiteIds()) {
    const site = builtinSite(id);
    const own = labs.filter((l) => l.site === id);
    if (!own.length) continue;
    const fits = await validateLabsOnSite(own, site);
    for (const f of fits) {
      if (f.ok) {
        if (!quiet) console.log(`${C.green("✓")} ${f.lab.id}  ${C.dim(`${f.checks} checks on ${id}`)}`);
      } else {
        failed++;
        console.log(`${C.red("✗")} ${f.lab.id}`);
        for (const p of f.problems) console.log(`    ${p}`);
      }
    }
  }
  const orphan = labs.filter((l) => !builtinSiteIds().includes(l.site));
  for (const l of orphan) {
    failed++;
    console.log(`${C.red("✗")} ${l.id}: site "${l.site}" is not a built-in site`);
  }
  console.log(failed ? C.red(`\n${failed} lab${failed === 1 ? "" : "s"} failed`) : C.green(`\nAll ${labs.length} labs passed`));
  return failed ? 1 : 0;
}

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const flag = (name: string): boolean => {
    const i = args.indexOf(name);
    if (i < 0) return false;
    args.splice(i, 1);
    return true;
  };
  const option = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  if (flag("--version") || flag("-v")) {
    console.log(VERSION);
    return 0;
  }
  if (flag("--help") || flag("-h") || !args.length) {
    console.log(USAGE);
    return args.length || argv.length ? 0 : 1;
  }
  const quiet = flag("--quiet") || flag("-q");
  const labsDir = option("--labs") ?? LABS_DIR;
  const [cmd, ...rest] = args;
  switch (cmd) {
    case "validate":
      return validateSites(rest, labsDir, quiet);
    case "validate-labs":
      return validateAllLabs(labsDir, quiet);
    default:
      console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.stack : e);
    process.exit(1);
  },
);
