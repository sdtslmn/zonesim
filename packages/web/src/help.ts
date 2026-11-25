// The Help tab: renders docs/help/*.md, the same pages people read on GitHub.
// A small Markdown renderer is enough for these pages: headings, paragraphs,
// lists, tables, code blocks, inline code, bold and links.

const raw = import.meta.glob("../../../docs/help/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Pages in reading order. */
const ORDER = ["getting-started.md", "commands.md", "hmi.md", "devices.md", "concepts.md", "modbus.md", "customize.md", "faq.md"];

export interface HelpPage {
  file: string;
  title: string;
  text: string;
}

export const HELP_PAGES: HelpPage[] = Object.entries(raw)
  .map(([path, text]) => {
    const file = path.split("/").pop()!;
    const title = text.match(/^#\s+(.+)$/m)?.[1] ?? file;
    return { file, title, text };
  })
  .sort((a, b) => (ORDER.indexOf(a.file) + 1 || 99) - (ORDER.indexOf(b.file) + 1 || 99));

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(text: string): string {
  // Code spans first, so nothing inside them is touched.
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
      if (/^[a-z-]+\.md(#.*)?$/.test(href)) return `<a href="#" data-help="${href.replace(/#.*/, "")}">${label}</a>`;
      if (/^https?:\/\//.test(href)) return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
      return label;
    });
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
}

export function renderMarkdown(text: string): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let i = 0;
  const isBlockStart = (l: string) => /^(#{1,4}\s|```|\s*[-*]\s|\s*\d+\.\s|\|)/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      const level = Math.min(h[1].length + 1, 4);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    if (line.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        const cells = lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{3,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      out.push(`<div class="table-wrap"><table class="md"><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const li = line.match(/^\s*([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      const ordered = /\d/.test(li[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*]|\d+\.)\s+(.*)$/);
        if (m) {
          items.push(m[2]);
          i++;
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1] += " " + lines[i].trim();
          i++;
        } else break;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</${tag}>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++].trim());
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}

export function helpPanel(file: string): string {
  const page = HELP_PAGES.find((p) => p.file === file) ?? HELP_PAGES[0];
  if (!page) return "<p>No help pages found.</p>";
  const nav = HELP_PAGES.map((p) => `<button class="chip${p.file === page.file ? " active" : ""}" data-help="${p.file}">${esc(p.title)}</button>`).join("");
  const i = HELP_PAGES.indexOf(page);
  const next = HELP_PAGES[i + 1];
  return `<div class="help-nav">${nav}</div><article class="help">${renderMarkdown(page.text)}</article>${next ? `<p class="next-page"><a href="#" data-help="${next.file}">Next: ${esc(next.title)} →</a></p>` : ""}`;
}
