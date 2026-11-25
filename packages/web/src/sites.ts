// Sites in the browser: the built-in ones, plus site files the learner loaded.
// Loaded files are kept in localStorage, as text, so they can be edited and
// downloaded again.

import { BUILTIN_SITE_FILES, SITE_TEMPLATES, DEFAULT_SITE, loadSiteFile, builtinSite, type Site, type SiteLoadResult } from "@zonesim/core";

const SITES_KEY = "zonesim.sites";
const ACTIVE_KEY = "zonesim.site";

export interface SiteEntry {
  id: string;
  name: string;
  builtin: boolean;
  text: string;
}

function readSaved(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(SITES_KEY) ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeSaved(all: Record<string, string>): void {
  try {
    localStorage.setItem(SITES_KEY, JSON.stringify(all));
  } catch {
    /* storage may be off or full; the site still works in this tab */
  }
}

export function listSites(): SiteEntry[] {
  const out: SiteEntry[] = Object.keys(BUILTIN_SITE_FILES).map((id) => ({ id, name: builtinSite(id).name, builtin: true, text: BUILTIN_SITE_FILES[id] }));
  for (const [id, text] of Object.entries(readSaved())) {
    const r = loadSiteFile(text);
    out.push({ id, name: r.site?.name ?? `${id} (has problems)`, builtin: false, text });
  }
  return out;
}

export function siteText(id: string): string | undefined {
  return BUILTIN_SITE_FILES[id] ?? readSaved()[id];
}

export function isBuiltin(id: string): boolean {
  return id in BUILTIN_SITE_FILES;
}

/** Check a site file and, if it is good, save it. */
export function addSite(text: string): SiteLoadResult {
  const r = loadSiteFile(text);
  if (!r.site) return r;
  if (isBuiltin(r.site.id)) {
    return { errors: [`id "${r.site.id}" belongs to a built-in site. Give your site its own id, for example ${r.site.id}-copy.`], warnings: r.warnings };
  }
  const all = readSaved();
  all[r.site.id] = text;
  writeSaved(all);
  return r;
}

export function removeSite(id: string): void {
  const all = readSaved();
  delete all[id];
  writeSaved(all);
  if (activeSiteId() === id) setActiveSite(DEFAULT_SITE);
}

export function activeSiteId(): string {
  try {
    return localStorage.getItem(ACTIVE_KEY) ?? DEFAULT_SITE;
  } catch {
    return DEFAULT_SITE;
  }
}

export function setActiveSite(id: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    /* fine */
  }
}

/** The site to start with: the saved choice, if it still loads. */
export function startSite(): Site {
  const id = activeSiteId();
  if (isBuiltin(id)) return builtinSite(id);
  const text = readSaved()[id];
  const site = text ? loadSiteFile(text).site : undefined;
  return site ?? builtinSite();
}

export function templateText(): string {
  return Object.values(SITE_TEMPLATES)[0] ?? "";
}

/** Fetch a site file from a URL (must allow CORS). */
export async function fetchSite(url: string): Promise<{ text?: string; error?: string }> {
  let u: URL;
  try {
    u = new URL(url, location.href);
  } catch {
    return { error: `"${url}" is not a valid address` };
  }
  if (u.protocol !== "https:" && u.hostname !== "localhost") return { error: "Use an https:// address." };
  try {
    const res = await fetch(u.href, { credentials: "omit" });
    if (!res.ok) return { error: `The server answered ${res.status} ${res.statusText}.` };
    const text = await res.text();
    if (text.length > 512 * 1024) return { error: "The file is larger than 512 KB, which is too large for a site file." };
    return { text };
  } catch {
    return { error: "Could not fetch it. The server may not allow loading from other sites (CORS). A GitHub Gist raw link works." };
  }
}

export function download(name: string, text: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/yaml" }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
