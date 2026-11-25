# The HMI screen

The **HMI** tab is the operator screen of the plant's HMI host (`hmi-01` at Riverside, `hmi-1` at Kestrel, `bms-01` at Harbour, `scr-1` on the Meridian Line). Pick the **Operator** job and it opens by itself.

It works the way a real HMI does:

- It shows what the HMI host **last read** from the controllers, not the real process. The **Plant** tab shows the real process, so you can compare the two.
- Every button and setpoint is a **Modbus write from the HMI host** to its controller, across the network. The firewall filters it and the IDS sees it, like any other traffic. The HMI is in the IDS baseline of normal writers, so its writes raise no alert.
- If a conduit blocks the HMI, or its switch port goes down, the screen goes **stale** and the commands get **no response**.

## Reading the screen

The screens follow the high-performance HMI style used in modern control rooms:

| What you see | What it means |
|---|---|
| Grey, calm graphics | Normal. Colour is kept for things that need attention |
| Dark filled pump, compressor or chiller | Running. Light means stopped |
| Dark filled valve | Closed. Light means open |
| Red square with 1 | Priority 1 alarm: act now |
| Amber triangle with 2 | Priority 2 alarm: act soon |
| Blue circle with 3 | Priority 3 alarm: act when you can |
| Blinking alarm mark | Not acknowledged yet |
| Magenta value or dashed outline | Stale: the HMI has not heard from that controller recently, so the value may be wrong |

The top bar shows each controller the HMI polls, with **OK** or **COMM FAIL**, and the plant time. The alarm banner at the bottom shows the three most important alarms; **Alarms** lists them all, and **Events** lists what operators did and what came of it.

## Giving commands

Click a piece of equipment (or tab to it and press Enter) to open its **faceplate**: its values, and the commands the operator can give.

- **Start and stop, auto and manual**: the current state is the dark button. Some commands only work in one mode: the pump's start and stop at Riverside, for example, only in manual. The faceplate says why a button is disabled.
- **Setpoints**: type a value and press **Set** or Enter. The HMI keeps setpoints within a safe range, shown next to the name. It also checks that the start level stays below the stop level, and so on.
- **Confirmations**: commands that can hurt the plant (stopping chlorine dosing, stopping the chilled water pumps, putting anti-surge control in manual, opening the metro feeder breaker) ask first.
- **Several controllers**: the HMI writes to its own controller, and to other controllers it polls where the IDS baseline lists it as a normal writer. The metro control room, for example, runs both the traction power and the tunnel fans.
- **Safety systems are read-only**: the SIS at Riverside, the ESD at Kestrel, the fire panel at Harbour and the emergency trip system on the Meridian Line appear on the HMI, but it cannot change them.

After each command the faceplate shows the result: **Done** with the Modbus write it sent (for example `fc 6 hr 1 (LSP_STOP) = 750`), or **No response from plc-1** with the reason from the firewall, or the Modbus exception the controller returned.

## Why this matters for security

- The range limits and confirmations are in the HMI, not in the controller. A Modbus write from any other host skips them: `ssh corp-pc modbus write plc-1 hr 1 990` sets a stop level of 99 % that the HMI would never send. That is why the network has to keep other hosts away from the controllers.
- When you segment the plant, the HMI must keep reading and writing its controller. If the operator's commands get no response after your changes, a conduit rule is missing or too strict.
- When the HMI goes stale, the operators are blind. In the real world that alone is a reportable incident at many plants.

In the terminal, `hmi` prints the same values as text, and `hmi actions` lists what operators did.
