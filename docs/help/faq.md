# FAQ

## Is anything real touched?

No. The plant, the network, the devices and the vendor are simulated in your
browser. ZoneSim sends nothing anywhere, except when you load a site from a
URL.

## Where is my progress kept?

In this browser's local storage, along with your own sites. Another browser
or device starts fresh.

## A firewall rule does not work. Why?

Check, in this order:

1. Are the two hosts in different zones? Inside a zone, everything talks.
2. Is there a conduit between exactly those two zones? `conduit list`.
3. Does a rule on that conduit match, in the right direction? `fw list`.
   Rules are one way and the first match wins.
4. For Modbus, does the rule allow that function code?

`test SRC DST SERVICE` gives the verdict and the reason, and `fw log` shows
what was dropped.

## My request times out

A dropped request looks like a timeout to the sender, as in a real
network. That is usually the firewall doing its job. `fw log` tells you
which conduit dropped it.

## The HMI says COMM FAIL

The HMI polls its controller every few seconds. If your design blocks that
flow, operators lose their view of the plant. `plant` shows the blocked flow
and the reason.

## Why does my site run some labs on the built-in plant?

A lab needs every role it uses (for example a jump host), and its solution
must still solve it on your plant. The Site tab shows the reason for each
lab. See [Use your own plant](customize.md).

## Which plant should I start with?

Riverside is the gentlest: one simple process and two controllers. The
compressor station adds a control centre over a WAN and a commercial meter;
the data centre adds life safety, power monitoring and customers on the
internet. The ideas carry over, so pick the one closest to your work.

## Is there a command line version?

The simulator runs in the browser. The repository has a small command line
tool that checks site files and labs, for authors and CI:
`npm run validate -- my-site.yaml`.

## Which standards do the labs follow?

IEC 62443 (zones and conduits, security levels, system requirements), with
references to NIST SP 800-82, IEC 61511 and MITRE ATT&CK for ICS where they
fit. ZoneSim is a training aid, not a compliance tool.

## How do I report a problem or suggest a lab?

Open an issue on GitHub. Labs are YAML files, so new ones are welcome as
pull requests.
