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
  `gas-compressor-station`, `data-centre-cooling` or `metro-line` (each
  plant as found), or
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
| `zones` | the zones as found, with the hosts in each. Most plants start with one flat zone. A zone can name its `vlan`, or a firewall `port` such as `wan1` for an outside link; ZoneSim picks one when you leave it out |
| `conduits` | conduits as found, with rules such as `allow from vendor-laptop to ews-01 rdp` |
| `process` | the process model (`water-tank`, `gas-compressor`, `dc-cooling` or `metro-line`), tag names, and parameters such as levels, pressures, temperatures and alarm limits |
| `devices` | Modbus controllers: vendor, product, firmware, and the point map |
| `network` | the firewall and the switches: brand, model, management address, and which host is on which switch port. Hosts you leave off every switch go on the first one |
| `hmi` | which host is the HMI, which controller it shows, and when it reports a communication failure |
| `polling` | traffic the plant sends by itself, and how often. `when: takeover` marks polls that only run once a backup centre has taken over |
| `flows` | data flows the plant needs. Blocking one breaks something. `when: takeover` marks flows only needed after a takeover |
| `standby` | a main control centre with a passive backup: which hosts stop when the main centre is lost, and which host takes over |
| `ids` | what the IDS treats as normal: who writes to which controller, which controllers are safety systems, who may read device identification |

The template has a comment on every section.

A `network` section looks like this:

```yaml
network:
  firewall: { name: fw-01, vendor: fortinet, model: FortiGate Rugged 60F, ip: 192.168.250.1 }
  switches:
    - name: sw-01
      vendor: hirschmann          # or cisco
      ip: 192.168.250.11
      ports: { "1/1": corp-pc, "1/2": historian, "1/3": hmi-01, "1/4": plc-1, "1/5": null }
```

Cisco ports are written `Gi1/1`. A port with `null` is a spare. When a site extends another, you can change a switch's brand alone with `network: { switches: [{ name: sw-01, vendor: cisco }] }`; the Site tab does the same with a menu. See [Firewall and switches](devices.md) for what you can do on them.

### A passive backup control centre

Some plants are run from a control centre with a backup that stays passive until the main one is lost, like the OCC and BOCC of the Meridian Line metro. Describe it with `standby`, and mark the backup's polls and flows with `when: takeover`:

```yaml
standby:
  centre: OCC                 # what the main centre is called
  backupName: BOCC            # and the backup
  backup: bocc-scada          # the backup's control system
  lost: [occ-scada, ews-1, historian]   # hosts that stop when the main centre is lost
polling:
  - { from: bocc-scada, to: tps-1, service: modbus, fc: [3, 4], every: 2, when: takeover }
flows:
  - { id: bocc-plc, when: takeover, why: The BOCC runs the traction power once it takes over., from: bocc-scada, to: tps-1, service: modbus, fc: [1, 2, 3, 4, 5, 6] }
```

`lost` must include the HMI host: during a takeover the backup runs the operator screen. In the terminal, `takeover start` loses the main centre and `takeover end` brings it back. Two checks join the design review: the backup stays passive (it reaches no controller while the main centre has control) and it can take over (its flows work once its rules are switched on). Rules you switch off with `fw disable` count as ready.

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

### Metro line (`metro-line`)

| Signal | Table | Meaning |
| --- | --- | --- |
| `feeder.command`, `rectifier.enable`, `control.auto`, `possession` | coil | feeder breaker close command, rectifier on, auto reclose, work possession registered |
| `fan1.run`, `fan2.run`, `vent.auto`, `fire.mode` | coil | tunnel fans in manual, auto ventilation, fire mode |
| `sis.bypass` | coil | emergency trip bypass |
| `feeder.closed`, `rectifier.running`, `alarm.trip` | di | substation states |
| `fan1.running`, `fan2.running`, `alarm.tunnel_hot`, `fire.mode_active` | di | ventilation states |
| `sis.tripped`, `sis.bypassed`, `crew.on_track` | di | emergency trip state and the possession key switch |
| `voltage.line` | ir | line voltage, V |
| `current.feeder`, `sis.current` | ir | feeder current, A |
| `trains.moving`, `trains.stranded` | ir | trains moving, trains stopped in the tunnel |
| `temp.tunnel` | ir | tenths of a °C |
| `setpoint.overcurrent`, `sis.trip_current` | hr | feeder trip and backup trip, A |
| `setpoint.fan_start` | hr | tunnel temperature at which the first fan starts, tenths of a °C |

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
