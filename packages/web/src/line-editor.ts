// A small readline for xterm.js: editing, history, Ctrl+C, paste and tab completion.

import type { Terminal } from "@xterm/xterm";

export interface LineEditorOptions {
  prompt: () => string;
  continuation: string;
  onLine: (line: string) => Promise<void>;
  onInterrupt: () => void;
  complete?: (line: string) => string[];
}

export class LineEditor {
  private buffer = "";
  private cursor = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private saved = "";
  private busy = false;
  private continuing = false;
  private queue: string[] = [];
  /** Rows between the first prompt row and the row the cursor is on (long lines wrap). */
  private rowsAbove = 0;
  /** Keys typed while a command is still running (type-ahead). */
  private typeahead = "";

  constructor(
    private term: Terminal,
    private opts: LineEditorOptions,
  ) {
    term.onData((data) => this.onData(data));
  }

  private get promptText(): string {
    return this.continuing ? this.opts.continuation : this.opts.prompt();
  }

  /** Visible length of the prompt (without colour codes). */
  private promptWidth(): number {
    return this.promptText.replace(/\x1b\[[0-9;]*m/g, "").length;
  }

  showPrompt(continuing = false): void {
    this.continuing = continuing;
    this.buffer = "";
    this.cursor = 0;
    this.rowsAbove = 0;
    this.term.write(this.promptText);
  }

  /** Repaint the prompt and buffer, handling lines that wrap past the terminal width. */
  private redraw(): void {
    const cols = Math.max(1, this.term.cols);
    let seq = "";
    if (this.rowsAbove > 0) seq += `\x1b[${this.rowsAbove}A`;
    seq += "\r\x1b[J" + this.promptText + this.buffer;
    const pw = this.promptWidth();
    const len = pw + this.buffer.length;
    const target = pw + this.cursor;
    // xterm keeps the cursor on the last column when text ends exactly at the edge.
    const endRow = len > 0 && len % cols === 0 ? len / cols - 1 : Math.floor(len / cols);
    const targetRow = Math.floor(target / cols);
    const targetCol = target % cols;
    if (targetRow > endRow) seq += "\n";
    else if (endRow > targetRow) seq += `\x1b[${endRow - targetRow}A`;
    seq += "\r" + (targetCol ? `\x1b[${targetCol}C` : "");
    this.rowsAbove = targetRow;
    this.term.write(seq);
  }

  private insert(text: string): void {
    this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
    this.cursor += text.length;
    this.redraw();
  }

  private async submit(): Promise<void> {
    const line = this.buffer;
    this.cursor = this.buffer.length;
    this.redraw();
    this.term.write("\r\n");
    this.rowsAbove = 0;
    if (line.trim() && !this.continuing) {
      this.history.push(line);
      if (this.history.length > 500) this.history.shift();
    }
    this.historyIndex = -1;
    this.busy = true;
    await this.opts.onLine(line);
    this.busy = false;
    if (!this.queue.length && this.typeahead) {
      this.buffer = this.typeahead;
      this.cursor = this.buffer.length;
      this.typeahead = "";
      this.redraw();
    }
    if (this.queue.length) {
      const next = this.queue.shift()!;
      this.buffer = next;
      this.cursor = next.length;
      this.redraw();
      await this.submit();
    }
  }

  setContinuing(value: boolean): void {
    this.continuing = value;
  }

  private onData(data: string): void {
    if (this.busy) {
      if (data === "\x03") {
        this.typeahead = "";
        this.opts.onInterrupt();
        return;
      }
      if (data === "\x7f") {
        this.typeahead = this.typeahead.slice(0, -1);
        return;
      }
      if (data.startsWith("\x1b")) return;
      // Keep what the user types while a command runs, like a real terminal.
      const parts = data.split(/\r\n|\r|\n/);
      for (let i = 0; i < parts.length; i++) {
        this.typeahead += parts[i].replace(/[\x00-\x1f]/g, "");
        if (i < parts.length - 1) {
          this.queue.push(this.typeahead);
          this.typeahead = "";
        }
      }
      return;
    }
    // Pasted text with newlines: run line by line.
    if (data.length > 1 && /[\r\n]/.test(data) && !data.startsWith("\x1b")) {
      const lines = data.split(/\r\n|\r|\n/);
      const last = lines.pop() ?? "";
      if (lines.length) {
        this.insert(lines.shift()!);
        this.queue.push(...lines);
        if (last) this.queue.push(last);
        void this.submit();
        return;
      }
    }
    switch (data) {
      case "\r":
        void this.submit();
        return;
      case "\x7f":
      case "\b":
        if (this.cursor > 0) {
          this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
          this.cursor--;
          this.redraw();
        }
        return;
      case "\x1b[3~":
        if (this.cursor < this.buffer.length) {
          this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
          this.redraw();
        }
        return;
      case "\x1b[D":
        if (this.cursor > 0) {
          this.cursor--;
          this.redraw();
        }
        return;
      case "\x1b[C":
        if (this.cursor < this.buffer.length) {
          this.cursor++;
          this.redraw();
        }
        return;
      case "\x1b[H":
      case "\x01":
        this.cursor = 0;
        this.redraw();
        return;
      case "\x1b[F":
      case "\x05":
        this.cursor = this.buffer.length;
        this.redraw();
        return;
      case "\x1b[A":
        if (this.history.length === 0) return;
        if (this.historyIndex === -1) {
          this.saved = this.buffer;
          this.historyIndex = this.history.length - 1;
        } else if (this.historyIndex > 0) this.historyIndex--;
        this.buffer = this.history[this.historyIndex];
        this.cursor = this.buffer.length;
        this.redraw();
        return;
      case "\x1b[B":
        if (this.historyIndex === -1) return;
        if (this.historyIndex < this.history.length - 1) {
          this.historyIndex++;
          this.buffer = this.history[this.historyIndex];
        } else {
          this.historyIndex = -1;
          this.buffer = this.saved;
        }
        this.cursor = this.buffer.length;
        this.redraw();
        return;
      case "\x03":
        this.cursor = this.buffer.length;
        this.redraw();
        this.term.write("^C\r\n");
        this.opts.onInterrupt();
        this.showPrompt(false);
        return;
      case "\x0c":
        this.term.write("\x1b[H\x1b[2J");
        this.term.clear();
        this.rowsAbove = 0;
        this.redraw();
        return;
      case "\x15":
        this.buffer = this.buffer.slice(this.cursor);
        this.cursor = 0;
        this.redraw();
        return;
      case "\x17": {
        const before = this.buffer.slice(0, this.cursor).replace(/\S+\s*$/, "");
        this.buffer = before + this.buffer.slice(this.cursor);
        this.cursor = before.length;
        this.redraw();
        return;
      }
      case "\t": {
        if (!this.opts.complete) return;
        const options = this.opts.complete(this.buffer.slice(0, this.cursor));
        const word = this.buffer.slice(0, this.cursor).split(/\s+/).pop() ?? "";
        if (options.length === 1) this.insert(options[0].slice(word.length) + " ");
        else if (options.length > 1) {
          let prefix = options[0];
          for (const o of options) while (!o.startsWith(prefix)) prefix = prefix.slice(0, -1);
          if (prefix.length > word.length) this.insert(prefix.slice(word.length));
          else {
            const keep = this.cursor;
            this.cursor = this.buffer.length;
            this.redraw();
            this.term.write("\r\n" + options.join("  ") + "\r\n");
            this.rowsAbove = 0;
            this.cursor = keep;
            this.redraw();
          }
        }
        return;
      }
    }
    if (data.startsWith("\x1b")) return;
    // Printable text (typed or pasted on one line).
    const printable = data.replace(/[\x00-\x1f]/g, "");
    if (printable) this.insert(printable);
  }
}
