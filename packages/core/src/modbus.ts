// Modbus TCP basics shared by the controllers, the network tools and the IDS.

export type PointTable = "coil" | "di" | "ir" | "hr";

export const TABLES: PointTable[] = ["coil", "di", "ir", "hr"];

export const TABLE_NAMES: Record<PointTable, string> = {
  coil: "Coils (read fc 1, write fc 5/15)",
  di: "Discrete inputs (read fc 2)",
  ir: "Input registers (read fc 4)",
  hr: "Holding registers (read fc 3, write fc 6/16)",
};

export interface ModbusRequest {
  fc: number;
  addr: number;
  count?: number;
  values?: number[];
}

export interface ModbusReply {
  ok: boolean;
  values?: number[];
  exception?: number;
  deviceId?: { vendor: string; product: string; revision: string };
}

export const FC_NAMES: Record<number, string> = {
  1: "read coils",
  2: "read discrete inputs",
  3: "read holding registers",
  4: "read input registers",
  5: "write single coil",
  6: "write single register",
  15: "write multiple coils",
  16: "write multiple registers",
  43: "read device identification",
};

export const READ_FCS = [1, 2, 3, 4, 43];
export const WRITE_FCS = [5, 6, 15, 16];

export const EXCEPTIONS: Record<number, string> = {
  1: "illegal function",
  2: "illegal data address",
  3: "illegal data value",
  4: "server device failure",
};

/** Which table a signal belongs in, from its type and whether it can be written. */
export function tableFor(type: "bool" | "int", writable: boolean): PointTable {
  if (type === "bool") return writable ? "coil" : "di";
  return writable ? "hr" : "ir";
}
