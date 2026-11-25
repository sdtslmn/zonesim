# Commands

Every command has `--help`, for example `fw --help`. Names in capitals are
what you fill in. Host names below are from the built-in Riverside plant;
your site may use other names.

## On the console

### Look around

| Command | What it does |
| --- | --- |
| `hosts` | hosts with their IP address, Purdue level, zone and services. `hosts -o wide` adds the role and operating system |
| `host show HOST` | everything about one host |
| `plant` | process values, alarms and the plant's data flows |
| `hmi` | what the operator sees on the HMI |
| `ssh HOST` | log in to a host. Its commands then send traffic from it |
| `ssh HOST COMMAND` | run one command on a host and come back |

### Design zones and conduits

| Command | What it does |
| --- | --- |
| `zone list` | zones and their hosts |
| `zone create NAME --sl 3` | a new, empty zone with a target security level |
| `zone add ZONE HOST...` | move hosts into a zone. A host is in exactly one zone |
| `zone show ZONE` | hosts, conduits and settings of a zone |
| `zone set ZONE --sl 2` | change the target security level |
| `zone delete ZONE` | delete an empty zone |
| `conduit create NAME ZONE1 ZONE2` | connect two zones. A new conduit denies everything |
| `conduit list`, `conduit show NAME`, `conduit delete NAME` | see or remove conduits |
| `fw allow CONDUIT from SRC to DST SERVICE` | allow one flow through a conduit |
| `fw allow ... modbus fc 3,4` | allow only some Modbus function codes. `fc read` means 1,2,3,4,43 |
| `fw deny CONDUIT from SRC to DST SERVICE` | block a flow explicitly |
| `fw ... at 1` | put the rule at a position instead of the end |
| `fw list [CONDUIT]` | rules with their numbers and hit counts |
| `fw delete CONDUIT N` | delete rule number N |
| `fw log` | traffic the firewalls blocked |
| `test SRC DST SERVICE [fc N]` | would this get through? Nothing is sent |
| `host config HOST mfa=on` | require multi-factor authentication for remote logins |

SRC and DST in a rule can be a host, a zone, or `any`. Rules are checked top
down and the first match wins. Traffic that matches no rule is denied.
Services are `ssh`, `http`, `https`, `modbus`, `rdp`, or `any`.

### Monitor and investigate

| Command | What it does |
| --- | --- |
| `flows` | who talks to whom, and what got blocked. `flows --mine` shows only your traffic |
| `alerts` | alerts from the IDS sensor and the process |
| `alerts show ID` | details of one alert |
| `alerts ack ID`, `alerts ack all` | acknowledge alerts |
| `report` | design review: required data flows and security checks |
| `wait SECONDS` | fast-forward the plant |

### Labs

| Command | What it does |
| --- | --- |
| `labs` | the list of labs |
| `lab N` | start lab N, for example `lab 3` or `lab b03` |
| `task` | the tasks of the current lab |
| `check` | check your work |
| `hint` | the next hint |
| `solution` | the commands that solve the lab |
| `reset` | start the lab again |
| `next` | the next lab |
| `sandbox` | the plant as found, no lab |

## On a host

After `ssh HOST`, these commands send traffic from that host:

| Command | What it does |
| --- | --- |
| `modbus read HOST TABLE ADDR [COUNT]` | read coils, discrete inputs, input or holding registers |
| `modbus write HOST TABLE ADDR VALUE` | write a coil or holding register |
| `modbus info HOST` | device identification (function code 43) |
| `modbus map HOST` | the register map from the vendor manual (sends nothing) |
| `nmap TARGET` | find hosts and open ports. TARGET is a host, an IP or a /24 network |
| `nmap -p 502 TARGET` | scan one port |
| `ping HOST`, `curl URL`, `ip addr` | the usual |
| `rdp HOST`, `ssh HOST` | log in to another host across the network |
| `exit` | leave this host |

TABLE is `coil`, `di`, `ir` or `hr`. See [Modbus](modbus.md).

## Shell features

Pipes into `grep`, `head`, `tail`, `wc` and `sort`. `;`, `&&` and `||`
between commands. `>` and `>>` write to files, and `echo`, `cat`, `ls` and
`rm` work on them. Files are only used by the labs; they live in your
browser tab.
