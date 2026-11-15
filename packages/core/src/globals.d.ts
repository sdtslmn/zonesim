// Minimal declarations for platform globals available in both modern
// browsers and Node 20+. The full DOM lib is left out on purpose, so the
// engine cannot depend on browser-only APIs by accident.

declare function setTimeout(fn: () => void, ms?: number): unknown;
