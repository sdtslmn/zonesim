# Modbus

Modbus TCP is one of the oldest and most common industrial protocols. It
has no authentication and no encryption: any host that reaches port 502 on a
controller can read and write it. That is why segmentation matters.

## The four tables

| Table | Name in ZoneSim | Holds | Access |
| --- | --- | --- | --- |
| Coils | `coil` | on/off outputs, such as a pump command | read and write |
| Discrete inputs | `di` | on/off inputs, such as "pump running" | read only |
| Input registers | `ir` | measurements, such as the tank level | read only |
| Holding registers | `hr` | settings, such as setpoints | read and write |

Values are 16-bit numbers. The vendor manual says how to scale them. A tank
level of 623 in tenths of a percent is 62.3 %. `modbus map HOST` shows the
manual's register map for a controller.

Addresses start at 0. Reading an address that does not exist returns
exception 2 (illegal data address), as a real device would.

## Function codes

| Code | What it does | Kind |
| --- | --- | --- |
| 1 | read coils | read |
| 2 | read discrete inputs | read |
| 3 | read holding registers | read |
| 4 | read input registers | read |
| 5 | write one coil | write |
| 6 | write one holding register | write |
| 15 | write several coils | write |
| 16 | write several holding registers | write |
| 43 | read device identification (vendor, product, firmware) | read |

In firewall rules, `fc read` means 1, 2, 3, 4 and 43.

## Examples

From a host (after `ssh hmi-01`):

```
modbus read plc-1 ir 0 2        tank level and chlorine
modbus read plc-1 hr 0 3        the three setpoints
modbus write plc-1 hr 1 750     pump stop level 75.0 %
modbus write plc-1 coil 1 0     chlorine dosing off
modbus info plc-1               vendor, product, firmware
```

## When something fails

- **Timeout**: the request was dropped on the way. A firewall rule or a
  missing conduit. `fw log` on the console shows why.
- **Exception 1**: the controller does not support that function code.
- **Exception 2**: no point at that address.
- **Exception 3**: a bad value, for example 2 written to a coil.
