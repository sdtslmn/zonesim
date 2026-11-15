// The learner's notes folder. Labs ask for answers in small text files
// (echo 10.10.10.10 > answer.txt). The CLI backs it with a real folder,
// the browser and the tests keep it in memory.

export interface FileSystem {
  readFile(path: string): string | undefined;
  writeFile(path: string, content: string): void;
  remove(path: string): boolean;
  list(): string[];
  /** Shown by pwd and in help text. */
  readonly home: string;
}

/** "~/a.txt", "./a.txt" and "/root/a.txt" all mean "a.txt". */
export function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/^~\//, "")
    .replace(/^\/root\//, "")
    .replace(/^(\.\/)+/, "");
}

export function validFileName(path: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(path) && path !== "." && path !== "..";
}

export class MemoryFS implements FileSystem {
  readonly home = "/root";
  private files = new Map<string, string>();

  readFile(path: string): string | undefined {
    return this.files.get(normalizePath(path));
  }

  writeFile(path: string, content: string): void {
    this.files.set(normalizePath(path), content);
  }

  remove(path: string): boolean {
    return this.files.delete(normalizePath(path));
  }

  list(): string[] {
    return [...this.files.keys()].sort();
  }

  clear(): void {
    this.files.clear();
  }
}
