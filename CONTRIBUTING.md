# Contributing to ZoneSim

Thanks for helping. The most useful contributions are new labs, new built-in
sites, fixes where the simulator behaves unlike a real plant, and clearer
wording.

ZoneSim is a standalone project. Please keep it free of dependencies on other
simulator repositories.

## Set up

You need Node.js 20.19 or newer.

```
npm install
npm run build
npm test
npm run validate-labs
npm run dev:web        # the simulator on http://localhost:5173
```

## Adding a lab

1. Copy a lab from `labs/<site>/` that is close to what you want.
2. Follow the format in [docs/writing-labs.md](docs/writing-labs.md). Use
   placeholders such as `${plc}` instead of host names and addresses, so the
   lab also runs on sites people load themselves.
3. Run `npm run validate-labs` and `npm test`. They check that your lab is
   not solved before the solution runs, and that the solution solves it, on
   the built-in plant and on the template site.
4. Open a pull request with a short note on what the learner practises.

## Adding a process model

A process model is one file in `packages/core/src/process/`: its signals,
parameters, simulation step, readouts for the views, alarms and snapshot.
Register it in `process/index.ts`, add a site that uses it, and optionally a
picture in `packages/web/src/plant.ts` (without one, the Plant tab shows the
readouts as a table).

## Adding a built-in site

1. Add `sites/<id>.yaml`. The format is in
   [docs/help/customize.md](docs/help/customize.md), and
   `schema/site.schema.json` gives completion in editors.
2. Run `npm run build`. It embeds the site into the app
   (`packages/core/src/sites/builtin.generated.ts`, which is committed).
3. Run `npm run validate -- sites/<id>.yaml`.

If you change the site format, update `packages/core/src/site-schema.ts` and
run `npm run build && node scripts/build-schema.mjs`. A test checks that the
published schema is current.

## Writing style

Labs and help pages are read by people new to OT security, many of them not
native English speakers. Short sentences, plain words, no jargon without a
one-line explanation. Name the real standard or technique when it helps, but
do not present the simulator as a compliance tool.

## Code layout

- `packages/core`: the engine (site loader, process models, controllers,
  network policy, Modbus, IDS, shell, commands, labs). Runs in Node and in
  the browser.
- `packages/web`: the browser app (labs, help and site panels, network map,
  plant view, docked terminal).
- `packages/cli`: a small checker for site files and labs, for authors and
  CI.
- `sites/`: built-in sites, and the template in `sites/templates/`.
- `labs/`: the labs, one folder per plant, one YAML file per lab.
- `docs/help/`: the help pages, shown in the Help tab and readable on GitHub.
