# Writing labs

A lab is one YAML file in `labs/<level>/`. Labs refer to the plant through
placeholders, so the same lab runs on the built-in plant and on sites people
load themselves. Example:

```yaml
id: b03-operator-write          # unique, the prefix (b03) is what learners type
site: riverside-water           # the site the lab was written for
title: Change a setpoint like an operator
level: beginner                 # beginner, intermediate, advanced or scenario
minutes: 8
topic: Modbus basics
intro: |
  The plant manager wants the tank to stop filling at ${param.stopLevel-5} %
  instead of ${param.stopLevel} %.
setup:                          # console commands run quietly before the lab
  - zone create control         # setup can also play an attacker:
  - ssh ${office} modbus write ${plc} hr ${plc:setpoint.chlorine} 0
settle: 4                       # plant seconds to run after setup
tasks:
  - From ${hmi}, set ${plc} holding register ${plc:setpoint.stop} to ${param.stopLevel*10-50}.
checks:
  - name: The pump stop level is ${param.stopLevel-5} %
    register: { host: "${plc}", signal: setpoint.stop, equals: "${param.stopLevel*10-50}" }
hints:
  - Shown one at a time with the hint command.
solution:
  - ssh ${hmi} modbus write ${plc} hr ${plc:setpoint.stop} ${param.stopLevel*10-50}
learned: |
  What the learner should take away. Shown when every check passes.
refs:
  - IEC 62443-3-3 SR 5.1 (network segmentation)
```

Setup and solution lines run on the console. To run something on a host, use
`ssh HOST COMMAND`. A solution step that is meant to fail needs a comment,
and then the whole line must be quoted in YAML:
`- "ssh ${historian} modbus write ${plc} hr ${plc:setpoint.stop} 900   # times out, as it should"`.

## Placeholders

Placeholders are filled in from the site before the learner sees the lab.
They work in every text field and in checks.

| Placeholder | Becomes | On Riverside |
|---|---|---|
| `${plc}` | the host with role `plc` | `plc-1` |
| `${plc.ip}` | its IP address | `10.10.10.10` |
| `${plc.net}` | its /24 network | `10.10.10.0/24` |
| `${plc.zone}` | the zone it starts in | `site` |
| `${plc.firmware}`, `${plc.product}` | from its Modbus device | `2.4.1`, `ZS-PLC 100` |
| `${plc.user}` | its login user | |
| `${plc:setpoint.stop}` | the Modbus address of a signal on its device | `1` |
| `${param.stopLevel}` | a process parameter | `80` |
| `${param.stopLevel*10-50}` | arithmetic with parameters (`+ - * /` and brackets) | `750` |
| `${tag.tank}` | a process tag name | `T-101` |
| `${site.name}`, `${site.id}` | the site | |

Any role works in place of `plc`: `sis`, `hmi`, `ews`, `historian`,
`report-server`, `jump`, `office`, `vendor`, or roles a site defines. Inside
YAML flow mappings (`{ ... }`) and lists (`[ ... ]`), quote placeholders:
`host: "${plc}"`.

A string that is only one placeholder keeps its type, so
`equals: "${param.stopLevel*10-50}"` compares as a number.

Leave out numbers that a site could change. "Set the stop level to 75 %"
breaks on a site whose stop level is already 75 %; "lower it by 5 points" does
not.

## When a lab runs on a custom site

A lab runs on a learner's site when the site is the lab's `site` or extends
it, every placeholder resolves, the lab is not already solved at the start,
and the lab's own solution solves it. Otherwise the lab runs on its own site
and tells the learner why. `npm run validate -- my-site.yaml` shows the
result for every lab.

## Checks

Each check has a `name` and exactly one of these:

| Check | What it tests | Example |
|---|---|---|
| `flow` | Would this traffic get through? Nothing is sent. | `flow: { from: "${office}", to: "${plc}", service: modbus, fc: 6, expect: blocked }` |
| `required` | A plant data flow works, by id, or `all` | `required: historian-plc` |
| `risk` | A design check from `report` passes, by id, or `all` | `risk: sis-read-only` |
| `zone` | Where a host sits | `zone: { host: "${sis}", alone: true, slAtLeast: 3 }` |
| `register` | A controller point, read directly, by signal or by table and address | `register: { host: "${plc}", signal: dosing.enable, equals: 1 }` |
| `file` | A file in the learner's home folder | `file: { path: answer.txt, matches: '${office}' }` |
| `alert` | An alert exists, or is acknowledged | `alert: { title: Unauthorized, src: "${office}", acked: true }` |
| `host` | A host setting | `host: { name: "${jump}", mfa: true }` |
| `state` | Any value in the simulation snapshot | `state: { path: plant.overflowing, equals: false }` |
| `command` | Output of a console command | `command: fw log` with `outputMatches` or `outputNotMatches` |

`zone` options: `equals` (zone name), `with` and `notWith` (lists of hosts),
`alone`, `slAtLeast`. Prefer `with` and `notWith` over `equals`, so learners
can name their zones as they like.

Required flow ids come from the site. On Riverside: `hmi-plc`, `hmi-sis`,
`historian-plc`, `historian-sis`, `ews-plc`, `historian-replica`,
`office-reports`, `vendor-support`.

Design check ids: `segmented`, `office-to-control`, `internet-dmz-only`,
`sis-own-zone`, `sis-read-only`, `historian-read-only`, `remote-access`,
`least-privilege`.

## Test it

```
npm run validate-labs                     # every lab on its own site
npm run validate -- sites/templates/my-site.yaml   # every lab on another site
npm test                                  # includes every lab on the template site
```
