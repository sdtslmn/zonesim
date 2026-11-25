# ZoneSim

**An OT/ICS security training simulator.** Take a small water treatment plant
that sits on one flat network, and secure it: group the hosts into IEC 62443
zones, connect them with conduits and firewall rules, filter Modbus function
codes, route vendor access through a DMZ, and investigate the alerts when
someone attacks the plant. Or load your own site, with your host names,
addresses and Modbus map, and run the same labs on it. It runs in your
browser, and nothing real is touched.

**Try it in your browser: [sdtslmn.github.io/zonesim](https://sdtslmn.github.io/zonesim/)**

![ZoneSim during a lab: the lab on the left, the network map with a dropped Modbus write on the top right, and the terminal docked at the bottom](docs/images/web-lab.png)

## What you can do

- **Look around a working plant.** A tank, an inlet pump, chlorine dosing, a
  PLC and an independent safety system. Change a setpoint and the process
  responds. Turn off dosing and the water becomes unsafe. Bypass the safety
  system and the tank overflows.
- **Attack it from the inside.** Scan for controllers from the office PC, read
  the PLC's firmware, and write to it. Modbus has no login, so on a flat
  network that just works, and the IDS sees it.
- **Design zones and conduits.** Move hosts into zones, connect zones with
  conduits, and write least-privilege rules. Every conduit denies by default.
- **Filter Modbus.** Let the historian read with function codes 3 and 4 but
  never write, and keep the safety system read-only from the network.
- **Keep the plant running.** The plant needs eight data flows (HMI polling,
  historian collection, office reports, vendor support). Block one and the
  HMI goes blind or the reports stop, and the simulator tells you why.
- **Watch it happen.** The network map shows zones, conduits and every
  request as a dot: green when it gets through, red where a firewall stops it.
- **Get reviewed.** `report` checks your design against eight security
  checks, from "office cannot reach control" to "remote access goes through a
  jump host with MFA".
- **Bring your own plant.** Describe your site in a short YAML file and load
  it in the Site tab. The labs fill in your names, addresses, registers and
  setpoints.

## Labs

Every lab is checked automatically, with hints and a solution.

| # | Lab | Level |
|---|---|---|
| 1 | Get to know the plant | beginner |
| 2 | Read the process over Modbus | beginner |
| 3 | Change a setpoint like an operator | beginner |
| 4 | Why a flat network is dangerous | beginner |
| 5 | Group the hosts into zones | intermediate |
| 6 | Connect the zones with conduits | intermediate |
| 7 | Filter Modbus function codes | intermediate |
| 8 | Office reports through the DMZ | intermediate |
| 9 | Vendor remote access through a jump host | intermediate |
| 10 | Investigate an unauthorized write | advanced |
| 11 | Someone bypassed the safety system | scenario |
| 12 | Segment the whole plant from scratch | scenario |

Link straight to a lab with `?lab=`, for example
[sdtslmn.github.io/zonesim/?lab=i03](https://sdtslmn.github.io/zonesim/?lab=i03).

## The plant

The built-in site is Riverside, a small drinking water plant:

| Host | IP | Purdue level | Role |
|---|---|---|---|
| vendor-laptop | 203.0.113.50 | 5 Internet | Remote vendor support (`vendor`) |
| corp-pc | 10.10.40.21 | 4 Enterprise | Office workstation (`office`) |
| hist-dmz | 10.10.35.10 | 3.5 DMZ | Historian copy for office reports (`report-server`) |
| jump-01 | 10.10.35.20 | 3.5 DMZ | Remote access jump host (`jump`) |
| historian | 10.10.30.10 | 3 Operations | Process historian (`historian`) |
| hmi-01 | 10.10.20.10 | 2 Supervisory | Operator HMI (`hmi`) |
| ews-01 | 10.10.20.30 | 2 Supervisory | Engineering workstation (`ews`) |
| plc-1 | 10.10.10.10 | 1 Control | Tank and dosing PLC, Modbus TCP (`plc`) |
| sis-1 | 10.10.10.20 | 1 Control | Safety instrumented system, Modbus TCP (`sis`) |

The plant, the devices, the vendor and the register maps are fictional. The
whole site is one file: [sites/riverside-water.yaml](sites/riverside-water.yaml).

## Use your own plant

Start from the [template](sites/templates/my-site.yaml), change what you
need, and load it in the **Site** tab. Anything you leave out comes from
Riverside:

```yaml
schema: zonesim-site/1
id: my-water-plant
name: Northgate water works
extends: riverside-water
rename: { plc-1: tank-plc, hmi-01: scada-hmi }
hosts:
  - { name: tank-plc, ip: 192.168.10.10 }
  - { name: scada-hmi, ip: 192.168.20.10 }
process:
  params: { stopLevel: 75 }
```

Labs find hosts by role, so they keep working: lab 3 now asks you to set
tank-plc's stop level from scada-hmi, to 70 %. ZoneSim checks every lab
against your site and runs the ones that do not fit on Riverside, with the
reason. Share a site with a link: `?site=https://.../my-site.yaml`.

The full guide is in [docs/help/customize.md](docs/help/customize.md), and
[schema/site.schema.json](schema/site.schema.json) gives completion in
editors such as VS Code.

![The Site tab after loading a custom site: 12 of 12 labs run on it, and the lab text uses the site's own names](docs/images/web-site.png)

## A taste of the console

```
console:~$ ssh corp-pc modbus write plc-1 coil 1 0
plc-1 (10.10.10.10:502) fc 5, write single coil: coil 1 (P201_ENABLE) = 0  OK

console:~$ zone create enterprise --sl 1
console:~$ zone add enterprise corp-pc
console:~$ conduit create ent-dmz enterprise dmz
console:~$ fw allow ent-dmz from corp-pc to hist-dmz https

console:~$ fw allow ops-control from historian to plc-1 modbus fc 3,4
console:~$ test historian plc-1 modbus fc 6
✘ blocked  historian → plc-1 modbus fc 6
  function code 6 is not allowed by conduit ops-control rule 1
```

The console is an out-of-band management station: it designs zones and reads
alerts, but sends no plant traffic. To act from a host, `ssh` to it. Type
`help` for every command, or open the **Help** tab.

## The screen

Labs, Help and Site are on the left. The network map and the plant view are
on the top right, with a status strip. The terminal is docked at the bottom:
drag its edge to resize it, or fold it away. On a phone the panels stack
behind a tab bar.

## Run it on your computer

You need Node.js 20.19 or newer.

```
git clone https://github.com/sdtslmn/zonesim.git
cd zonesim
npm install
npm run dev:web                      # the simulator on http://localhost:5173
npm run validate -- my-site.yaml     # check a site file, and which labs run on it
```

`npm test` runs the tests and `npm run validate-labs` checks that every lab is
solved by its own solution.

## How close to reality is it?

Close enough to learn the ideas, simple enough to stay readable:

- Hosts in a zone talk freely. Traffic between zones needs a conduit between
  exactly those two zones, and its rules are checked top-down with an
  implicit deny at the end. Real networks route through several firewalls.
- Modbus TCP behaves like the real protocol for function codes 1 to 6, 15, 16
  and 43, including exceptions. Other protocols are modelled at the
  connection level only.
- The IDS uses simple rules (baseline writers, writes to the safety system,
  scans, device identification reads, remote access from the internet).
- Standards are referenced for orientation. ZoneSim is a training tool, not
  a compliance or assessment tool.

See [docs/roadmap.md](docs/roadmap.md) for what is coming next, and
[CONTRIBUTING.md](CONTRIBUTING.md) to add a lab.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
