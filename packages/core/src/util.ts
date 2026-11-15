// Small helpers shared by the engine and the commands: colours, tables and
// the error type commands use to report a mistake to the learner.

/** A mistake by the learner (unknown host, bad syntax ...). Printed without a stack trace. */
export class UserError extends Error {}

const wrap = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;

export const C = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
  gray: wrap("90"),
};

const ANSI = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

export function visibleLength(s: string): number {
  return stripAnsi(s).length;
}

function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visibleLength(s)));
}

/** A plain text table with columns padded to the widest cell, kubectl style. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(visibleLength(h), ...rows.map((r) => visibleLength(r[i] ?? ""))));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : pad(c, widths[i])))
      .join("   ")
      .trimEnd();
  return [line(headers), ...rows.map(line)].join("\n") + "\n";
}

/** Format seconds of plant time as 00:01:05. */
export function clock(t: number): string {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [h, m, s % 60].map((n) => String(n).padStart(2, "0")).join(":");
}

export function ago(seconds: number): string {
  if (seconds < 1) return "now";
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

/** Parse "3,4" or "1-4,6" into a sorted list of numbers. */
export function parseNumberList(text: string): number[] {
  const out = new Set<number>();
  for (const part of text.split(",").map((p) => p.trim()).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      for (let n = parseInt(range[1], 10); n <= parseInt(range[2], 10); n++) out.add(n);
    } else if (/^\d+$/.test(part)) out.add(parseInt(part, 10));
    else throw new UserError(`"${part}" is not a number`);
  }
  return [...out].sort((a, b) => a - b);
}

/** Join hard-wrapped lines into paragraphs. Blank lines, list items and indented lines stay. */
export function reflow(text: string): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const prev = out[out.length - 1];
    const plain = (l: string) => l.trim() !== "" && !/^\s/.test(l) && !/^[-*] /.test(l) && !/^\d+\. /.test(l);
    if (prev !== undefined && plain(prev) && plain(line)) out[out.length - 1] = `${prev} ${line.trim()}`;
    else out.push(line);
  }
  return out.join("\n");
}

/** Wrap text to a width, keeping existing line breaks. */
export function wrapText(text: string, width = 78, indent = ""): string {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (!para.trim()) {
      out.push("");
      continue;
    }
    const lead = para.match(/^\s*/)![0];
    let line = indent + lead;
    for (const word of para.trim().split(/\s+/)) {
      if (visibleLength(line) + visibleLength(word) + 1 > width && line.trim()) {
        out.push(line.trimEnd());
        line = indent + lead + (/^[-*] /.test(para.trim()) ? "  " : /^\d+\. /.test(para.trim()) ? "   " : "");
      }
      line += (line.trim() ? " " : "") + word;
    }
    out.push(line.trimEnd());
  }
  return out.join("\n");
}

/** Light markdown for the terminal: `code` in cyan, **bold** in bold. */
export function termMd(text: string): string {
  return text.replace(/`([^`]+)`/g, (_m, c: string) => C.cyan(c)).replace(/\*\*([^*]+)\*\*/g, (_m, b: string) => C.bold(b));
}
