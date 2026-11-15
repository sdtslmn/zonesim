# Roadmap

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

## Next

ZoneSim stays a standalone project with no dependencies on other simulator
repos.

- DNP3 next to Modbus, and a second site connected over a WAN
- More scenarios: ransomware spreading from the office, an insider on the
  engineering workstation, a rogue device in the control zone
- Write detection rules for the IDS and test them against recorded attacks
- A risk assessment lab that derives SL-T per zone (IEC 62443-3-2)
- PLC program change detection and backup
- A timed exam mode, and a classroom mode for trainers
