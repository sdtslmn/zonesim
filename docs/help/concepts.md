# Concepts

A short guide to the ideas the labs use. The references at the end of each
lab point to the standards.

## Purdue levels

The Purdue model sorts plant systems into levels, from the physical process
up to the business:

| Level | What lives there | In the built-in plant |
| --- | --- | --- |
| 5 | The internet, outside parties | vendor-laptop |
| 4 | Business and office IT | corp-pc |
| 3.5 | The DMZ between IT and OT | hist-dmz, jump-01 |
| 3 | Site operations | historian |
| 2 | Supervisory control | hmi-01, ews-01 |
| 1 | Controllers | plc-1, sis-1 |
| 0 | Sensors, pumps and valves | the tank and pumps |

The levels are a starting point for zones, not a rule. ZoneSim draws the
map in Purdue bands.

## Zones and conduits

IEC 62443-3-2 asks you to group assets with similar security needs into
**zones**, and to control all traffic between zones through **conduits**.

In ZoneSim:

- Every host is in exactly one zone. Hosts in the same zone talk freely.
- Traffic between zones needs a conduit between them, plus a firewall rule
  on that conduit that allows it.
- A new conduit has no rules, so it denies everything. You add back only
  what the plant needs: deny by default, allow by exception.
- Rules are one way. Allowing the historian to read the PLC does not let the
  PLC open connections to the historian.

## Target security level (SL-T)

Each zone gets a target security level from 1 to 4, from the risk
assessment. Roughly: SL 1 protects against mistakes, SL 2 against simple
deliberate attacks, SL 3 against skilled attackers with moderate resources,
SL 4 against well-funded ones. Safety and control zones usually get 3.

## Required data flows

A plant only works if certain traffic gets through: the HMI must poll the
PLC, the historian must record values, office staff need their reports. Each
site lists these flows. `plant` and `report` show which ones work and why a
blocked one fails. A secure design that stops the plant is not a good
design.

## Security checks

`report` runs a design review. The checks look at the network, not at
names, so they work on your own site too:

- Office, DMZ and plant hosts are in separate zones
- The office cannot reach the control network
- The internet only reaches the DMZ
- The safety system sits in its own zone
- No host can write to the safety system
- The historian can only read the controllers
- Remote access goes through the jump host with MFA
- Allow rules name hosts and services (no "any")

A check that needs a role your site does not have (a jump host, say) is
left out.

## The IDS

A passive sensor sees all traffic and raises alerts for scans, Modbus writes
from hosts that do not normally write, any write to the safety system,
device identification reads, and remote logins from outside. It detects;
it does not block. Prevention is the job of zones and conduits.

## Deep packet inspection

Plain Modbus is all or nothing: a host that may read may also write.
Industrial firewalls can look inside Modbus and allow only some function
codes. `fw allow ... modbus fc 3,4` lets a host read registers but not
write them.

## DMZ and jump hosts

Between office IT and the plant sits a DMZ. Data leaves the plant through a
copy in the DMZ (the historian pushes, the office reads the copy), and
remote access ends in the DMZ on a jump host with multi-factor
authentication, with a separate session from there into the plant.
