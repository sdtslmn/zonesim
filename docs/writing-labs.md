# Writing labs

A lab is one YAML file in `labs/<level>/`. Example:

```yaml
id: b03-operator-write          # unique, the prefix (b03) is what learners type
title: Change a setpoint like an operator
level: beginner                 # beginner, intermediate, advanced or scenario
minutes: 8
topic: Modbus basics
intro: |
  Short scene setting, a few sentences.
setup:                          # console commands run quietly before the lab
  - zone create control         # setup can also play an attacker:
  - ssh corp-pc modbus write plc-1 hr 2 0
settle: 4                       # plant seconds to run after setup
tasks:
  - What the learner does, one step per line. Use `backticks` for commands.
checks:
  - name: The pump stop level is 75.0 %
    register: { host: plc-1, table: hr, addr: 1, equals: 750 }
hints:
  - Shown one at a time with the hint command.
solution:
  - ssh hmi-01 modbus write plc-1 hr 1 750
learned: |
  What the learner should take away. Shown when every check passes.
refs:
  - IEC 62443-3-3 SR 5.1 (network segmentation)
```

Setup and solution lines run on the console. To run something on a host, use
`ssh HOST COMMAND`. A solution step that is meant to fail needs a comment,
and then the whole line must be quoted in YAML:
`- "ssh historian modbus write plc-1 hr 1 900   # times out, as it should"`.

## Checks

Each check has a `name` and exactly one of these:

| Check | What it tests | Example |
|---|---|---|
| `flow` | Would this traffic get through? Nothing is sent. | `flow: { from: corp-pc, to: plc-1, service: modbus, fc: 6, expect: blocked }` |
| `required` | A plant data flow works, by id, or `all` | `required: historian-plc` |
| `risk` | A design check from `report` passes, by id, or `all` | `risk: sis-read-only` |
| `zone` | Where a host sits | `zone: { host: sis-1, alone: true, slAtLeast: 3 }` |
| `register` | A controller point, read directly | `register: { host: plc-1, table: coil, addr: 1, equals: 1 }` |
| `file` | A file in the learner's home folder | `file: { path: answer.txt, matches: 'corp-pc' }` |
| `alert` | An alert exists, or is acknowledged | `alert: { title: Unauthorized, src: corp-pc, acked: true }` |
| `host` | A host setting | `host: { name: jump-01, mfa: true }` |
| `state` | Any value in the simulation snapshot | `state: { path: plant.overflowing, equals: false }` |
| `command` | Output of a console command | `command: fw log` with `outputMatches` or `outputNotMatches` |

`zone` options: `equals` (zone name), `with` and `notWith` (lists of hosts),
`alone`, `slAtLeast`. Prefer `with` and `notWith` over `equals`, so learners
can name their zones as they like.

Required flow ids: `hmi-plc`, `hmi-sis`, `historian-plc`, `historian-sis`,
`ews-plc`, `historian-replica`, `office-reports`, `vendor-support`.

Design check ids: `segmented`, `office-to-control`, `internet-dmz-only`,
`sis-own-zone`, `sis-read-only`, `historian-read-only`, `remote-access`,
`least-privilege`.
