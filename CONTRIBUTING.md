# Contributing to ZoneSim

Thanks for helping. The most useful contributions are new labs, fixes where
the simulator behaves unlike a real plant, and clearer wording.

## Set up

```
npm install
npm run build
npm test
npm run validate-labs
```

`npm run sim` starts the terminal version, `npm run dev:web` the browser
version.

## Adding a lab

1. Copy a lab from `labs/` that is close to what you want.
2. Follow the format in [docs/writing-labs.md](docs/writing-labs.md).
3. Run `npm run validate-labs`. It checks that your lab is not solved before
   the solution runs, and that the solution solves it.
4. Open a pull request with a short note on what the learner practises.

## Writing style

Labs are read by people new to OT security, many of them not native English
speakers. Short sentences, plain words, no jargon without a one-line
explanation. Name the real standard or technique when it helps, but do not
present the simulator as a compliance tool.

## Code layout

- `packages/core`: the engine (plant process, network policy, Modbus, IDS,
  shell, commands, labs). Runs in Node and in the browser.
- `packages/cli`: the terminal app.
- `packages/web`: the browser app (terminal, network map, plant view).
- `labs/`: the labs, one YAML file each.
