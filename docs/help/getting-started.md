# Getting started

ZoneSim is a training simulator for OT and ICS security. It runs a plant in
your browser, with controllers, a safety system, an HMI, a historian and an
office network, and a live process behind them. You segment it into zones
and conduits, filter Modbus, and handle alerts, and the labs check your work.

There are three plants, each with its own labs:

- **Riverside water treatment plant**: a tank, pumps, chlorine dosing and a
  safety trip on high level.
- **Kestrel compressor station**: a gas pipeline compressor with anti-surge
  protection, an emergency shutdown system, a flow computer, and a control
  centre that runs it over a WAN.
- **Harbour data centre**: chillers, pumps and CRAH units cooling a data
  hall, a power meter, and the fire suppression panel.

Nothing leaves your browser and nothing real is touched.

## The screen

- **Left**: the **Labs** list and the current lab, this **Help**, and the
  **Site** tab where you pick or load a plant.
- **Top right**: the **Map** of the network with live traffic, and the
  **Plant** view with the process, data flows, design checks and alerts. The
  strip above them shows the plant at a glance.
- **Bottom**: the **terminal**. Drag its top edge to make it taller or
  shorter, or fold it away with the arrow button. ZoneSim remembers your
  layout.

- **Top bar**: the **Site** button opens a menu to switch plant in one
  click, or load your own site. **Home** (or the ZoneSim name) takes you
  back to the start page: the lab list and a fresh console on your plant.

On a phone the panels stack, with a tab bar at the top.

## Your first five minutes

1. Open lab 1 of a plant on the left. Read the intro and the tasks.
2. Click in the terminal and type `hosts`. Press Enter.
3. Type `plant`, then `hmi`. You now know what is on the network and what
   the plant is doing.
4. Follow the tasks. When you think you are done, click **Check my work**
   or type `check`.
5. Stuck? **Hint** gives one hint at a time. **Solution** shows the
   commands.

## The console and the hosts

You start on the **console**, an out-of-band management station. Commands
there change the design (zones, conduits, firewall rules) and show you the
state of things, but they send no traffic on the plant network.

To act from a host, log in to it: `ssh hmi-01`. Commands on a host send real
(simulated) traffic, which the firewalls filter and the IDS watches. Type
`exit` to go back. You can also run one command on a host without logging
in: `ssh hmi-01 modbus read plc-1 hr 0 3`.

## Keyboard

| Key | What it does |
| --- | --- |
| Tab | complete a command, host or file name |
| Up, Down | earlier commands |
| Ctrl+C | cancel the line |
| Ctrl+L | clear the screen |
| Ctrl+A, Ctrl+E | start or end of the line |
| Ctrl+U, Ctrl+W | delete the line, or the last word |

## Progress

Finished labs are saved in this browser. Your own sites are saved here too.
Clearing the site data of this page removes both.

## Flat at the start

Every plant starts as found: one flat network, where the office PC can
reach the controllers. That is the problem the labs solve. To see what a
finished design looks like, pick **Riverside, segmented** in the Site tab.
To look around another plant without a lab, click **Explore this plant** in
the Labs tab.

## Next

- [Commands](commands.md) lists everything you can type.
- [Concepts](concepts.md) explains zones, conduits, Purdue levels and SL-T.
- [Modbus](modbus.md) explains the protocol the plant runs on.
- [Use your own plant](customize.md) shows how to load your own site.
