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

export type ReadoutState = "ok" | "warn" | "bad" | "idle";

/** One value shown on the plant views, the status strip and the HMI. */
export interface Readout {
  id: string;
  /** Full label, e.g. "Tank T-101 level". */
  label: string;
  /** Value with units, e.g. "62.3 %". */
  text: string;
  /** Context, e.g. "start 40 %, stop 80 %". */
  note?: string;
  state: ReadoutState;
  /** Short text for the status strip; readouts without it stay off the strip. */
  strip?: string;
  /** 0 to 100, to draw a bar. */
  bar?: number;
  /** Shown on the operator screen. */
  hmi?: boolean;
}

/** A value recorded every few seconds for the trend charts. */
export interface TrendSpec {
  signal: string;
  label: string;
  /** Raw value times scale gives engineering units. */
  scale: number;
  max: number;
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
  /**
   * Values for the views, worked out from signals only, so the same code
   * shows live values or what the HMI last read. safety is the name of the
   * safety system's host, if any.
   */
  readouts(get: (signal: string) => number, ctx: { safety?: string }): Readout[];
  /** Extra lines about the live process for the plant command, e.g. spillage so far. */
  notes(): string[];
  /** Why an alarm is up, for the alert it raises. */
  alarmDetail(id: string): string;
  /** Alarms that are shown but do not raise alerts (routine ones). */
  readonly quietAlarms: string[];
  /** Values lab checks can read as plant.NAME. */
  snapshot(): Record<string, number | boolean>;
  /** The values to chart, usually two. */
  readonly trends: TrendSpec[];
  /** The id of the readout the wait command reports, e.g. "level". */
  readonly headline: string;
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
