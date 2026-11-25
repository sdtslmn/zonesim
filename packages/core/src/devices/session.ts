// A terminal session on a network device, reached with ssh from the console.

import type { Sim } from "../sim.js";
import type { NetDevice } from "../infra.js";
import { UserError } from "../util.js";

export interface DeviceSession {
  readonly device: NetDevice;
  prompt(): string;
  /** Run one line. Output goes to out. */
  run(line: string, out: (text: string) => void): void;
  /** Words to offer for tab completion at the start of a line. */
  words(): string[];
  /** Words to offer after the words already typed (the last one is being typed). */
  complete(words: string[]): string[];
  /** True once the user logged out. */
  done: boolean;
}

/** Split a device command line into words, keeping "quoted strings" together. */
export function deviceTokens(line: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** A command pattern for prefix-matching CLIs. Lower-case words are keywords; <x> takes one word, <x...> the rest. */
export interface Pattern<M extends string> {
  modes: M[];
  words: string[];
  run: (args: string[]) => void;
  help?: string;
}

/**
 * Match words against patterns the way IOS and HiOS do: keywords may be
 * shortened to any unique prefix.
 */
export function matchPattern<M extends string>(patterns: Pattern<M>[], mode: M, tokens: string[]): { pattern: Pattern<M>; args: string[] } | { error: string } {
  type Alive = { p: Pattern<M>; args: string[]; done: boolean };
  let alive: Alive[] = patterns.filter((p) => p.modes.includes(mode)).map((p) => ({ p, args: [], done: false }));
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i].toLowerCase();
    const active = alive.filter((a) => !a.done && a.p.words[i] !== undefined);
    const literals = [...new Set(active.map((a) => a.p.words[i]).filter((w) => !w.startsWith("<")))];
    let chosen: string | undefined;
    if (literals.includes(tok)) chosen = tok;
    else {
      const pre = literals.filter((w) => w.startsWith(tok));
      if (pre.length === 1) chosen = pre[0];
      else if (pre.length > 1 && !active.some((a) => a.p.words[i].startsWith("<"))) return { error: `ambiguous:${tokens[i]}` };
    }
    const next: Alive[] = [];
    for (const a of alive) {
      if (a.done) {
        next.push(a);
        continue;
      }
      const w = a.p.words[i];
      if (w === undefined) continue;
      if (chosen !== undefined) {
        if (w === chosen) next.push(a);
        continue;
      }
      if (w.startsWith("<")) {
        if (w.endsWith("...>")) next.push({ p: a.p, args: [...a.args, tokens.slice(i).join(" ")], done: true });
        else next.push({ p: a.p, args: [...a.args, tokens[i]], done: false });
      }
    }
    if (!next.length) return { error: `invalid:${i}` };
    alive = next;
  }
  const complete = alive.filter((a) => a.done || a.p.words.length === tokens.length);
  if (complete.length) return { pattern: complete[0].p, args: complete[0].args };
  return { error: "incomplete" };
}

/** First words available in a mode, for completion and help. */
export function firstWords<M extends string>(patterns: Pattern<M>[], mode: M): string[] {
  return [...new Set(patterns.filter((p) => p.modes.includes(mode)).map((p) => p.words[0]))].filter((w) => !w.startsWith("<")).sort();
}

/** Completion for prefix-matching CLIs: the keywords that can follow what was typed. */
export function nextWords<M extends string>(patterns: Pattern<M>[], mode: M, typed: string[], values: (holder: string) => string[] = () => []): string[] {
  const out = new Set<string>();
  for (const p of patterns.filter((x) => x.modes.includes(mode))) {
    let ok = true;
    for (let i = 0; i < typed.length; i++) {
      const w = p.words[i];
      if (w === undefined) {
        ok = false;
        break;
      }
      if (w.endsWith("...>")) break;
      if (!w.startsWith("<") && !w.startsWith(typed[i].toLowerCase())) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const next = p.words[typed.length];
    if (!next) continue;
    if (next.startsWith("<")) for (const v of values(next)) out.add(v);
    else out.add(next);
  }
  return [...out].sort();
}

export function parseVlan(text: string): number {
  const n = parseInt(text, 10);
  if (!/^\d+$/.test(text) || n < 1 || n > 4042) throw new UserError(`VLAN ID ${text} is out of range (1 to 4042)`);
  return n;
}

export type SessionFactory = (sim: Sim, device: NetDevice) => DeviceSession;
