# Firewall and switches

Every plant has a firewall between its zones and one or more switches that the hosts plug into. You can log in to them and configure them in their own command line, the way a network engineer would on site.

- The firewall speaks **FortiOS** (Fortinet FortiGate).
- A switch speaks **Hirschmann HiOS** or **Cisco IOS**. Pick the brand of each switch in the Site tab.

Log in from the console with `ssh fw-01` or `ssh sw-01` (type `devices` to see the names on your plant), or pick the **Network engineer** job above the map and click a device. Type `exit` to go back to the console.

## How the devices and the zones fit together

Zones and conduits are not a separate thing from the devices. They are what the devices are configured to do:

| On the device | What it means in ZoneSim |
|---|---|
| A VLAN on the switches | A zone. VLAN 20 named `control` is the zone `control`. |
| A switch port's untagged VLAN (PVID) | The zone of the host on that port |
| A firewall interface | One per zone, named after it |
| A firewall policy | Firewall rules on the conduit between its two interfaces |
| An application control list | The Modbus function codes a rule lets through |

So the console commands and the device commands change the same thing. `zone create control` creates the next free VLAN (10, 20, 30 and so on) on the switches and an interface on the firewall. Moving a port to VLAN 20 on the switch moves its host into zone `control`. A policy you add on the FortiGate shows up in `fw list`, and a rule you add with `fw allow` shows up in `show firewall policy`.

Zones of hosts outside the plant (the internet, a company WAN) are firewall ports such as `wan1`, not VLANs.

## Hirschmann HiOS

You start in user mode, prompt `>`. Keywords can be shortened, for example `sh vl br`.

```
enable                              privileged mode, prompt #
vlan database                       VLAN mode
  vlan add 20                       create VLAN 20
  name 20 control                   name it (the name is the zone name)
  vlan delete 20
  exit
configure                           configuration mode
  interface 1/7                     a port
    vlan participation include 20   make the port a member of VLAN 20
    vlan participation exclude 1
    vlan pvid 20                    untagged frames go to VLAN 20
    shutdown / no shutdown
    exit
show vlan brief                     VLANs
show vlan id 20                     the ports of VLAN 20
show vlan port                      PVID and membership of every port
show port all                       ports and link state
show running-config script          the configuration as commands
save                                save to flash
```

A port needs both: the PVID and membership of that VLAN. With `vlan pvid 20` but without `vlan participation include 20`, the host on that port is cut off. `test` and `hosts` show it as link down.

## Cisco IOS

You start in user mode, prompt `>`. Abbreviations work, for example `conf t` and `sh vl br`.

```
enable
configure terminal
  vlan 20                           create VLAN 20
    name control
    exit
  interface Gi1/7
    switchport mode access
    switchport access vlan 20       put the port in VLAN 20
    shutdown / no shutdown
    exit
  do show vlan brief                show commands from configuration mode
  end
show vlan brief
show interfaces status
show running-config
write memory
```

## FortiOS

The prompt is the firewall's host name followed by `#`. Configuration works in blocks: `config` opens a table, `edit` opens an entry, `set` changes it, `next` saves the entry and `end` leaves the table. `abort` drops the entry you are editing.

```
config firewall policy
    edit 0                          a new policy (0 picks a free ID)
        set name "hmi-to-plc"
        set srcintf "operations"
        set dstintf "control"
        set srcaddr "historian"
        set dstaddr "plc-1"
        set service "MODBUS"
        set action accept
        set utm-status enable
        set application-list "modbus-read"
    next
end
```

Addresses: one per host is built in, named after the host, plus `all`. Services: `ALL`, `HTTP`, `HTTPS`, `SSH`, `RDP`, `PING`, `MODBUS`, and custom TCP services under `config firewall service custom` with `set tcp-portrange PORT`.

### Modbus function codes

The FortiGate filters Modbus by function code with an application control list. Each Modbus function is an application signature:

| Signature | Function code |
|---|---|
| `Modbus_Read.Coils` | 1 |
| `Modbus_Read.Discrete.Inputs` | 2 |
| `Modbus_Read.Holding.Registers` | 3 |
| `Modbus_Read.Input.Registers` | 4 |
| `Modbus_Write.Single.Coil` | 5 |
| `Modbus_Write.Single.Register` | 6 |
| `Modbus_Diagnostics` | 8 |
| `Modbus_Write.Multiple.Coils` | 15 |
| `Modbus_Write.Multiple.Registers` | 16 |
| `Modbus_Read.Device.ID` | 43 |
| `Modbus` | all of them |

A list that lets reads through and blocks everything else:

```
config application list
    edit "modbus-read"
        config entries
            edit 1
                set application Modbus_Read.Holding.Registers Modbus_Read.Input.Registers
                set action pass
            next
            edit 2
                set application Modbus
                set action block
            next
        end
    next
end
```

Entries are checked in order and the first one that names the function decides. Then turn the list on in the policy with `set utm-status enable` and `set application-list "modbus-read"`.

The OT signatures must be loaded for any of this to work:

```
config ips global
    set exclude-signatures none
end
```

With `exclude-signatures industrial` or `ot`, the firewall cannot tell one function code from another and lets all Modbus through on an accept policy. `get system status` shows which way it is set.

One simplification: on a real FortiGate, `set application` takes signature IDs on the command line and shows the names in the GUI. ZoneSim takes the names, which are easier to read and remember.

### Looking at traffic

```
execute log display                 recent traffic through the firewall, in FortiGate log format
diagnose firewall policy hits       how often each policy matched
show firewall policy 3              one policy
show application list               the application control lists
get system interface                the interfaces
```

Traffic inside one zone never reaches the firewall, so it is not in the log.

## Filtering output

Add `| include TEXT` (or `| grep TEXT`, `| exclude TEXT`, `| begin TEXT`) to any device command, for example `show running-config | include vlan`.

## About the brands

ZoneSim imitates the command lines of these products so you can practise the commands you will use on site. It covers the part of each command line that zones, conduits and Modbus filtering need, not all of it. ZoneSim is not affiliated with or endorsed by Fortinet, Belden (Hirschmann) or Cisco. The product names are trademarks of their owners and are used here only to say which command line a device imitates.
