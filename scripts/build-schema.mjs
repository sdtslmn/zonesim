// Writes schema/site.schema.json from packages/core (run after npm run build).
import { writeFileSync, mkdirSync } from "node:fs";
import { siteJsonSchema } from "../packages/core/dist/site-schema.js";

mkdirSync(new URL("../schema/", import.meta.url), { recursive: true });
writeFileSync(new URL("../schema/site.schema.json", import.meta.url), JSON.stringify(siteJsonSchema(), null, 2) + "\n");
console.log("wrote schema/site.schema.json");
