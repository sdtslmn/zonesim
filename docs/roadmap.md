# Roadmap

ZoneSim is being reworked around jobs: the people who work on a plant. Each
release adds one of them.

## In 0.6

- The metro now follows how metros are run: the PCS and TVCS SCADA, the
  historian, the engineering workstation and the DMZ sit at the OCC, and
  reach the controllers at the station over the backbone
- The backup OCC is passive: it sends nothing to the station until the OCC
  is lost. `takeover start` loses the OCC (its hosts stop, the BOCC runs the
  operator screen and polls), `takeover end` brings it back
- Site files can describe a passive backup centre (`standby`), and polls
  and flows that only apply after a takeover (`when: takeover`)
- Two new design checks: the backup stays passive, and it can take over.
  `fw disable` and `fw enable` keep a rule but switch it off or on, so the
  BOCC's rules can be built, tested and left off
- The IDS flags any write from the passive BOCC while the OCC has control
- Metro labs rewritten for the OCC, plus a new one: the OCC is evacuated,
  take over from the BOCC (12 metro labs, 46 in all)

## In 0.5

- A fourth plant, the Meridian Line metro: a traction power substation
  (rectifier, 750 V DC feeder breaker with overcurrent protection and auto
  reclose), trains that are stranded in the tunnel when the line goes dead,
  tunnel ventilation with a fire mode, and an emergency trip system that
  keeps the third rail dead while a crew works on the track
- The OCC and the backup OCC run the line over the metro WAN; the traction
  power maker supports it from the internet
- 11 metro labs, from a tour to an attack that strands trains, a lowered
  protection setting that keeps tripping the feeder, a live rail under a
  track crew, and a full zone and conduit design
- An HMI screen for the OCC, which runs both the traction power and the
  tunnel fans (the HMI now writes to every controller it is a
  normal writer for)

## In 0.4

- An HMI screen for each plant, in the high-performance HMI style: grey and
  calm, dark for running equipment, colour only for alarms, magenta for
  stale values
- Click equipment to open its faceplate: start and stop, auto and manual,
  setpoints with safe ranges, confirmations for commands that can hurt the
  plant. Safety systems are shown but read-only
- The HMI shows what the HMI host last read, and every command is a Modbus
  write from the HMI host through the firewall. When the network blocks it,
  the screen goes stale and commands get no response
- Alarms with priorities, acknowledgement and an alarm list; an events list
  of operator actions (`hmi actions` in the terminal)
- The Operator job opens the HMI

## In 0.3

- Jobs above the map: operator, network engineer, SOC analyst and attacker.
  Each job connects the terminal to the places that person works from
- A firewall and switches on every plant, with their own command lines:
  FortiOS on the firewall, Hirschmann HiOS or Cisco IOS on the switches (pick
  the brand of each switch in the Site tab)
- Zones are VLANs on the switches or firewall ports; conduit rules are
  firewall policies; Modbus function code filtering is an application control
  list. The console commands and the device commands change the same thing
- A switch port that is shut down, or not a member of its own VLAN, cuts its
  host off
- The firewall's traffic log and policy hit counters
- Site files describe the network: the firewall, the switches and which host
  is on which port, and the VLAN or firewall port of each zone

## Next, by job

- SOC analyst: an OT monitoring console (asset inventory, communication
  baseline, alerts with packet details) in the style of the OT network
  monitoring tools used on site
- Labs rewritten per job, so a lab says who you are and where you work from
- Network engineer: more firewall brands

## In 0.2

- Bring your own plant: describe a site in a YAML file (host names, IP
  addresses, Purdue levels, Modbus maps, process parameters, data flows, IDS
  baseline), starting from the built-in plant with `extends` and `rename`
- Load sites in the browser from a file, a URL (`?site=`) or the built-in
  editor; they are saved in the browser
- Labs use roles and placeholders, so they run on custom sites; each lab is
  checked against the chosen site and falls back to its own site when it does
  not fit
- A JSON Schema for site files, for completion and checks in editors
- Two new plants, each with 11 labs: Kestrel compressor station (gas
  pipeline: anti-surge, ESD, relief valve, fiscal flow computer, a control
  centre over a WAN) and Harbour data centre (N+1 chillers, CRAH units, IT
  load and PUE, a fire suppression panel, a customer portal)
- A reference site, `riverside-segmented`: Riverside with the finished zone
  and conduit design
- New layout: Labs, Help and Site on the left, map and plant on the top
  right, and the terminal docked at the bottom (resizable, foldable); stacked
  panels on phones
- Help pages inside the app: getting started, commands, concepts, Modbus,
  using your own plant, FAQ
- The interactive terminal app is replaced by the browser app; the command
  line tool now checks site files and labs (`zonesim validate`)

## In 0.1

- A simulated water treatment plant: tank, inlet pump, chlorine dosing, a
  PLC and an independent safety system, with real consequences (overflow,
  unsafe water) when settings change
- Nine hosts across the Purdue levels, starting on a flat network
- Zones, conduits and firewall rules, including Modbus function code filtering
- Modbus TCP read, write and device identification, nmap-style scanning,
  ping, curl, rdp and ssh between hosts
- A passive IDS sensor (unauthorized writes, writes to the safety system,
  scans, reconnaissance, remote access from the internet)
- Plant data flows and a design review with eight security checks
- 12 labs, from a plant tour to a full zone and conduit design
- Browser app with a live network map and plant view, and a terminal app

## Later

ZoneSim stays a standalone project with no dependencies on other simulator
repos.

- More plants: an electrical substation (with DNP3 or IEC 61850) and a wastewater pumping station
- Metro: signalling interfaces, platform screen doors, and IEC 60870-5-104 for the traction power SCADA
- DNP3 next to Modbus, and a second site connected over a WAN
- More scenarios: ransomware spreading from the office, an insider on the
  engineering workstation, a rogue device in the control zone
- Write detection rules for the IDS and test them against recorded attacks
- A risk assessment lab that derives SL-T per zone (IEC 62443-3-2)
- PLC program change detection and backup
- A timed exam mode, and a classroom mode for trainers
