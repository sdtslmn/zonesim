# Use your own plant

The built-in plant is Riverside, a small water treatment plant. You can
describe your own site in a short YAML file: your host names, IP addresses,
Modbus map, setpoints and the traffic your plant needs. The labs then run on
your plant, with your names in the tasks.

## The quick way

1. Open the **Site** tab and click **Download template**. You get
   `my-site.yaml`.
2. Edit it in any text editor. Change what you need and delete the rest.
   Anything you leave out comes from the built-in plant.
3. In the **Site** tab, click **Load a site file** and pick your file. Or
   paste the text into **Paste or edit a site file** and click **Load**.

ZoneSim checks the file, tells you about any problems in plain words, and
shows which labs run on your site. Your sites are saved in this browser.

## A small example

```yaml
schema: zonesim-site/1
id: my-water-plant
name: Northgate water works
extends: riverside-water

rename:
  plc-1: tank-plc
  hmi-01: scada-hmi

hosts:
  - { name: tank-plc, ip: 192.168.10.10 }
  - { name: scada-hmi, ip: 192.168.20.10 }

process:
  params:
    stopLevel: 75
```

This keeps the whole Riverside plant but renames two hosts, gives them new
addresses and stops the pump at 75 % instead of 80 %. In lab 3 the task
then reads "set the pump stop level (tank-plc holding register 1) to 70 %".

## How a site file works

- `extends` names a built-in site to start from: `riverside-water`,
  `gas-compressor-station` or `data-centre-cooling` (each plant as found), or
  `riverside-segmented` (Riverside with a finished zone and conduit design).
  A site file without `extends` must describe everything.
- `rename` renames hosts or zones. Every reference is updated for you:
  zones, firewall rules, Modbus devices, data flows and the IDS baseline.
- Lists are merged by name (hosts, zones, conduits) or id (flows). An item
  with a new name is added. An item with a known name changes only the
  fields you give. Add `remove: true` to delete one.
- `devices` are merged per controller. A points table you give (`coil`,
  `di`, `ir` or `hr`) replaces the inherited table completely.
- `polling` replaces the inherited list as a whole.

## The sections

| Section | What it describes |
| --- | --- |
| `hosts` | name, role, IP address, Purdue level (5, 4, 3.5, 3, 2, 1, 0), kind (`external`, `it`, `dmz`, `ot`), services, OS, login user, description |
| `zones` | the zones as found, with the hosts in each. Most plants start with one flat zone |
| `conduits` | conduits as found, with rules such as `allow from vendor-laptop to ews-01 rdp` |
| `process` | the process model (`water-tank`, `gas-compressor` or `dc-cooling`), tag names, and parameters such as levels, pressures, temperatures and alarm limits |
| `devices` | Modbus controllers: vendor, product, firmware, and the point map |
| `hmi` | which host is the HMI, which controller it shows, and when it reports a communication failure |
| `polling` | traffic the plant sends by itself, and how often |
| `flows` | data flows the plant needs. Blocking one breaks something |
| `ids` | what the IDS treats as normal: who writes to which controller, which controllers are safety systems, who may read device identification |

The template has a comment on every section.

## Roles

Labs find hosts by **role**, not by name, so they keep working after you
rename things. The labs use these roles:

| Role | In Riverside |
| --- | --- |
| `plc` | plc-1, the tank and dosing controller |
| `sis` | sis-1, the safety instrumented system |
| `hmi` | hmi-01, the operator HMI |
| `ews` | ews-01, the engineering workstation |
| `historian` | historian |
| `report-server` | hist-dmz, the historian copy in the DMZ |
| `jump` | jump-01, the remote access jump host |
| `office` | corp-pc, an office workstation |
| `vendor` | vendor-laptop, the remote vendor |

The other plants add a few: `control-centre` (the pipeline control centre at
the compressor station), `meter` (the flow computer, or the power meter
gateway in the data centre) and `customer` (a colocation customer). Each
role names one host. Hosts you add can have their own roles or none.

## The Modbus map

Each point exposes a **signal** of the process. The table follows from the
signal: writable on/off signals are coils, writable numbers are holding
registers, read-only on/off signals are discrete inputs, read-only numbers
are input registers. ZoneSim tells you if a point is in the wrong table.

`modbus map HOST` in the simulator lists a controller's points, and the
JSON Schema lists every signal. The signals of each model:

### Water tank (`water-tank`)


| Signal | Table | Meaning |
| --- | --- | --- |
| `pump.command` | coil | inlet pump run command in manual mode |
| `dosing.enable` | coil | chlorine dosing on or off |
| `control.auto` | coil | 1 = automatic level control |
| `sis.bypass` | coil | bypass of the safety trip |
| `pump.running`, `dosing.running` | di | pumps running |
| `alarm.high`, `alarm.low`, `alarm.overflow` | di | level alarms |
| `sis.tripped`, `sis.bypassed` | di | safety system state |
| `level`, `sis.level` | ir | tank level, tenths of a % |
| `chlorine` | ir | chlorine residual, hundredths of mg/L |
| `setpoint.start`, `setpoint.stop` | hr | pump start and stop levels, tenths of a % |
| `setpoint.chlorine` | hr | chlorine setpoint, hundredths of mg/L |
| `sis.trip_level` | hr | safety trip level, tenths of a % |

### Gas compressor (`gas-compressor`)

| Signal | Table | Meaning |
| --- | --- | --- |
| `compressor.run`, `control.auto`, `antisurge.auto`, `sis.bypass` | coil | run command, auto speed, auto anti-surge, trip bypass |
| `compressor.running`, `alarm.surge`, `alarm.high_pressure`, `alarm.venting` | di | compressor and alarm states |
| `sis.tripped`, `sis.bypassed`, `valve.esd_closed` | di | ESD state |
| `pressure.suction`, `pressure.discharge`, `sis.pressure` | ir | pressures, tenths of a bar |
| `speed`, `recycle` | ir | speed and recycle valve position, tenths of a % |
| `flow`, `meter.flow` | ir | station flow and metered flow, thousand Sm³/h |
| `surge.margin` | ir | distance from surge, % |
| `setpoint.discharge`, `sis.trip_pressure` | hr | tenths of a bar |
| `setpoint.speed`, `setpoint.recycle` | hr | manual speed and valve position, tenths of a % |
| `meter.factor` | hr | flow computer meter factor, 10000 = 1.0000 |

### Data centre cooling (`dc-cooling`)

| Signal | Table | Meaning |
| --- | --- | --- |
| `chiller1.enable`, `chiller2.enable`, `pump.run`, `control.auto` | coil | chillers available, pumps, auto sequencing |
| `fire.isolate`, `fire.release` | coil | isolate the suppression, manual release |
| `chiller1.running`, `chiller2.running`, `pump.running` | di | plant states |
| `alarm.high_temp`, `alarm.critical_temp` | di | above the recommended or allowable range |
| `fire.isolated`, `fire.alarm`, `fire.discharged` | di | fire panel states |
| `temp.cold_aisle`, `temp.chw_supply`, `fire.temp` | ir | temperatures, tenths of a °C |
| `load.it`, `power.cooling` | ir | kW |
| `pue` | ir | hundredths, 135 = 1.35 |
| `setpoint.chw`, `setpoint.supply_air` | hr | tenths of a °C |

## Which labs run on my site

A lab runs on your site when your site extends the lab's plant, has every
role the lab uses, and the lab's own solution still solves it on your
plant. The Site tab shows the result for each lab of that plant. A lab that
does not fit runs on the plant it was written for, and says so. Labs of the
other plants always run on their own plant.

For example, if you remove the jump host, the labs that use it run on
Riverside instead.

## Checking a file before you share it

From a clone of the repository:

```
npm ci
npm run validate -- my-site.yaml
```

This prints the problems, if any, and which labs run on the site. It exits
with 1 on errors, so it works in CI.

For completion and checks while you type, VS Code with the YAML extension
reads the schema named on the first line of the template.

## Sharing a site

Put the file somewhere that serves it over HTTPS with CORS allowed (a GitHub
Gist's raw link or GitHub Pages work), then share the simulator link with
`?site=` and the file's address:

```
https://sdtslmn.github.io/zonesim/?site=https://example.org/my-site.yaml
```

The file is loaded in the visitor's browser. Nothing is uploaded to
ZoneSim.

## Writing labs for your site

Labs use placeholders instead of names, so one lab works on many sites. See
[writing labs](https://github.com/sdtslmn/zonesim/blob/main/docs/writing-labs.md).
