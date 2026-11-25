// A process model simulates the physical plant. Controllers expose its
// signals as Modbus points, as mapped in the site file.

export interface SignalSpec {
  name: string;
  type: "bool" | "int";
  writable: boolean;
  description: string;
}

export interface ParamSpec {
  name: string;
  default: number;
  min: number;
  max: number;
  description: string;
}

export interface PlantAlarm {
  id: string;
  text: string;
  severity: "critical" | "high" | "medium" | "low";
}

export interface ProcessModel {
  readonly model: string;
  /** Display names, e.g. tank: T-101. */
  readonly tags: Record<string, string>;
  readonly params: Record<string, number>;
  step(dt: number): void;
  /** Current value of a signal (booleans as 0 or 1). */
  get(signal: string): number;
  /** Write a signal. Returns false if it does not exist or is read-only. */
  set(signal: string, value: number): boolean;
  alarms(): PlantAlarm[];
}

export interface ProcessModelType {
  model: string;
  description: string;
  signals: SignalSpec[];
  params: ParamSpec[];
  /** Tag names with their defaults. */
  tags: Record<string, string>;
  /** Extra checks on parameter values, e.g. stop level above start level. */
  check(params: Record<string, number>): string[];
  create(params: Record<string, number>, tags: Record<string, string>): ProcessModel;
}
