// The built-in sites, and loading a site file with them available to extend.

import { BUILTIN_SITE_FILES, SITE_TEMPLATES } from "./builtin.generated.js";
import { loadSite, type Site, type SiteLoadResult } from "../site.js";
import { Network } from "../network.js";

export { BUILTIN_SITE_FILES, SITE_TEMPLATES };

export const DEFAULT_SITE = "riverside-water";

/** Checks that need the engine: firewall rules must parse against the hosts and zones. */
export function verifySite(site: Site): string[] {
  try {
    new Network(site);
    return [];
  } catch (e) {
    return [(e as Error).message];
  }
}

/** Load a site file (YAML text). It may extend any built-in site. */
export function loadSiteFile(text: string): SiteLoadResult {
  return loadSite(text, { builtins: BUILTIN_SITE_FILES, verify: verifySite });
}

const cache = new Map<string, Site>();

/** A built-in site by id. Throws if the built-in file is broken (tests catch that). */
export function builtinSite(id: string = DEFAULT_SITE): Site {
  const hit = cache.get(id);
  if (hit) return hit;
  const text = BUILTIN_SITE_FILES[id];
  if (!text) throw new Error(`no built-in site "${id}"`);
  const r = loadSiteFile(text);
  if (!r.site) throw new Error(`built-in site ${id} is invalid:\n${r.errors.join("\n")}`);
  cache.set(id, r.site);
  return r.site;
}

export function builtinSiteIds(): string[] {
  return Object.keys(BUILTIN_SITE_FILES);
}
