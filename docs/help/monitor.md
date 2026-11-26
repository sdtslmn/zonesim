# The OT monitor

The **Monitor** tab is the SOC analyst's console. Pick the **SOC analyst** job
and it opens by itself. It shows what the plant's IDS sensor sees: the
sensor sits on a mirror port of the plant switch and watches the traffic the
firewall lets through. It never sends anything, so it cannot break the plant.

## Learning and protecting

The sensor learned the plant while it was commissioned: the plant's own
polling and the data flows the site file lists. That is the **baseline**, the
traffic it treats as normal.

- **Protecting** (the default): anything outside the baseline raises an
  anomaly alert. A **New link** is a host talking to another over a service
  it never used before. A **New function code** is a known link carrying a
  Modbus function code it never carried, such as the HMI suddenly sending
  function code 16.
- **Learning**: whatever the sensor sees becomes normal, and it raises no
  anomaly alerts. Use it for a planned change and switch back straight
  after. Leave a sensor learning during an intrusion and the intrusion
  becomes normal.

**Rule alerts** don't depend on the baseline and fire in both modes: a Modbus
write from a host that never writes to that controller, any write to a
safety system, a network scan, a device identification read from outside
engineering, and remote access from the internet straight into the plant.

## The tabs

| Tab | What it shows |
| --- | --- |
| Dashboard | open alerts by severity, the asset count, links outside the baseline, the hosts behind the alerts, and the traffic of the last minute |
| Alerts | every alert, filtered by state (open or all) and kind (rule, anomaly, process). Click one for the details: the hosts involved, the MITRE ATT&CK for ICS techniques, what to check first, the traffic behind it, and buttons to acknowledge it or learn it as normal |
| Assets | the asset inventory: type, IP address, zone, vendor, model and firmware for controllers, the OS for computers, and when each was last seen. A host outside the baseline is marked new |
| Links | who talks to whom, over what, and which Modbus function codes. Anything outside the baseline is marked new. The **Baseline** view lists what the sensor treats as normal and how it got there, and lets you forget a link |
| Traffic | the packets themselves: time, hosts, service, what each Modbus request did, and whether the firewall blocked it. Plant polling is hidden until you tick it |

## Identifying controllers

The sensor knows a controller's vendor, model and firmware once it has seen a
device identification reply (Modbus function code 43). The engineering
workstation read most controllers while the sensor was commissioned, so they
start identified. A controller nobody has read shows **not identified yet**.

## Telling an attack from a change

1. Open the alert. Read what happened, who sent it and what to check.
2. Click the source host: what it is, who it talks to, and its other alerts.
3. Look at its traffic. Did it read first, then write? Did it scan?
4. Decide. A planned change, like a new engineering laptop or an HMI screen
   that writes a new register, gets **Learn as normal**. Anything else: put
   the plant right from the HMI, then block the source at the conduit (the
   network engineer job).
5. Acknowledge the alerts you have handled.

## In the terminal

| Command | What it does |
| --- | --- |
| `ids` | the sensor: mode, baseline, assets and open alerts |
| `ids mode learning`, `ids mode protecting` | switch the mode |
| `ids links`, `ids links --new` | links the sensor has seen, or only those outside the baseline |
| `ids baseline`, `ids baseline delete N` | what the sensor treats as normal, and forgetting a learned link |
| `ids learn ID` | accept what an anomaly alert saw as normal |
| `assets`, `assets HOST` | the asset inventory, or one asset |
| `alerts show ID` | an alert with its ATT&CK techniques and what to check |

The console is an original design for practice, in the style of the OT
network monitoring tools used on site, and is not affiliated with any vendor.
