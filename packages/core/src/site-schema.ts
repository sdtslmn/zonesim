// JSON Schema for site files, so editors (VS Code with the YAML extension,
// for example) can complete and check them while you type. The simulator
// does its own, stricter validation when it loads a site.
//
// schema/site.schema.json is generated from this file by scripts/build-schema.mjs.

import { PROCESS_MODELS } from "./process/index.js";
import { LEVELS, SITE_SCHEMA, SITE_SERVICES, HOST_KINDS } from "./site.js";
import { TABLES } from "./modbus.js";

const NAME = { type: "string", pattern: "^[a-z][a-z0-9-]{0,23}$" };
const FC = { type: "array", items: { type: "integer", minimum: 1, maximum: 127 } };

export function siteJsonSchema(): Record<string, unknown> {
  const models = Object.values(PROCESS_MODELS);
  const signals = [...new Set(models.flatMap((m) => m.signals.map((s) => s.name)))];
  const params: Record<string, unknown> = {};
  for (const m of models) for (const p of m.params) params[p.name] = { type: "number", minimum: p.min, maximum: p.max, default: p.default, description: p.description };
  const tags: Record<string, unknown> = {};
  for (const m of models) for (const [k, v] of Object.entries(m.tags)) tags[k] = { type: "string", default: v };

  const point = {
    type: "object",
    required: ["addr", "signal"],
    additionalProperties: false,
    properties: {
      addr: { type: "integer", minimum: 0, maximum: 65535, description: "Modbus address, starting at 0" },
      tag: { type: "string", description: "Tag name, as in the PLC program" },
      signal: { enum: signals, description: "The process signal this point exposes" },
      description: { type: "string" },
      units: { type: "string", description: "How to scale the raw value" },
    },
  };
  const hop = {
    type: "object",
    required: ["from", "to", "service"],
    additionalProperties: false,
    properties: { from: NAME, to: NAME, service: { enum: SITE_SERVICES }, fc: FC },
  };

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://sdtslmn.github.io/zonesim/schema/site.schema.json",
    title: "ZoneSim site file",
    description: "A plant for the ZoneSim OT/ICS security simulator. See docs/help/customize.md.",
    type: "object",
    required: ["schema", "id", "name"],
    additionalProperties: false,
    properties: {
      schema: { const: SITE_SCHEMA },
      id: { type: "string", pattern: "^[a-z][a-z0-9-]{1,40}$", description: "Short id, lower-case letters, digits and dashes" },
      name: { type: "string", description: "Shown in the simulator" },
      description: { type: "string" },
      extends: { type: "string", description: "A built-in site to start from, e.g. riverside-water. Anything you leave out comes from it." },
      rename: {
        type: "object",
        description: "Rename hosts or zones of the site being extended. Every reference is updated.",
        additionalProperties: NAME,
      },
      process: {
        type: "object",
        additionalProperties: false,
        properties: {
          model: { enum: models.map((m) => m.model), description: "The process the plant runs" },
          tags: { type: "object", properties: tags, additionalProperties: { type: "string" }, description: "Display names, e.g. tank: T-101" },
          params: { type: "object", properties: params, additionalProperties: false },
        },
      },
      hosts: {
        type: "array",
        items: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: {
            name: NAME,
            remove: { type: "boolean", description: "Remove this host from the site being extended" },
            role: { type: "string", pattern: "^[a-z][a-z0-9-]*$", description: "What the host does. Labs find hosts by role (plc, sis, hmi, ews, historian, report-server, jump, office, vendor)." },
            ip: { type: "string", format: "ipv4" },
            level: { enum: LEVELS, description: "Purdue level. 3.5 is the DMZ." },
            kind: { enum: [...HOST_KINDS] },
            services: { type: "array", items: { enum: SITE_SERVICES } },
            os: { type: "string" },
            user: { type: "string", description: "The account you get with ssh" },
            description: { type: "string" },
          },
        },
      },
      zones: {
        type: "array",
        description: "The zones as found. A zone you list replaces the zone of that name.",
        items: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: {
            name: NAME,
            remove: { type: "boolean" },
            description: { type: "string" },
            sl: { enum: [1, 2, 3, 4], description: "Target security level (SL-T)" },
            hosts: { type: "array", items: NAME },
          },
        },
      },
      conduits: {
        type: "array",
        items: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: {
            name: NAME,
            remove: { type: "boolean" },
            zones: { type: "array", items: NAME, minItems: 2, maxItems: 2 },
            rules: { type: "array", items: { type: "string", description: "allow|deny from SRC to DST SERVICE [fc LIST]" } },
          },
        },
      },
      devices: {
        type: "object",
        description: "Modbus controllers, by host name. A points table you give replaces the inherited one.",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          properties: {
            remove: { type: "boolean" },
            title: { type: "string" },
            vendor: { type: "string" },
            product: { type: "string" },
            revision: { type: "string", description: "Firmware revision, returned by function code 43" },
            points: {
              type: "object",
              additionalProperties: false,
              properties: Object.fromEntries(TABLES.map((t) => [t, { type: "array", items: point }])),
            },
          },
        },
      },
      hmi: {
        type: "object",
        additionalProperties: false,
        properties: { host: NAME, device: NAME, timeout: { type: "number", minimum: 1 } },
      },
      polling: {
        type: "array",
        description: "Traffic the plant generates by itself. Replaces the inherited list.",
        items: { ...hop, required: ["from", "to", "service", "every"], properties: { ...hop.properties, every: { type: "number", minimum: 1 } } },
      },
      flows: {
        type: "array",
        description: "Data flows the plant needs. Give from/to/service for one hop, or paths for alternatives.",
        items: {
          type: "object",
          required: ["id"],
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            remove: { type: "boolean" },
            title: { type: "string" },
            why: { type: "string" },
            from: NAME,
            to: NAME,
            service: { enum: SITE_SERVICES },
            fc: FC,
            paths: { type: "array", items: { type: "array", items: hop } },
          },
        },
      },
      ids: {
        type: "object",
        additionalProperties: false,
        properties: {
          writers: { type: "object", additionalProperties: { type: "array", items: NAME }, description: "Hosts that normally write to each controller" },
          safety: { type: "array", items: NAME, description: "Controllers where any write is critical" },
          identify: { type: "array", items: NAME, description: "Hosts allowed to read device identification" },
        },
      },
    },
  };
}
