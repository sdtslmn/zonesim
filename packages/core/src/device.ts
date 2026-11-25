// A controller: answers Modbus requests by reading and writing the process
// signals its point map exposes. No authentication, like most real ones.

import type { ProcessModel } from "./process/index.js";
import type { SiteDevice, SitePoint } from "./site.js";
import type { ModbusReply, ModbusRequest, PointTable } from "./modbus.js";

export class Controller {
  constructor(
    readonly host: string,
    readonly def: SiteDevice,
    readonly model: ProcessModel,
  ) {}

  private pointAt(t: PointTable, addr: number): SitePoint | undefined {
    return this.def.points[t].find((p) => p.addr === addr);
  }

  /** Read a point directly (lab checks, views). */
  point(t: PointTable, addr: number): number | undefined {
    const p = this.pointAt(t, addr);
    return p ? this.model.get(p.signal) : undefined;
  }

  /** Where a signal is mapped on this controller. */
  find(signal: string): { table: PointTable; point: SitePoint } | undefined {
    for (const t of ["coil", "di", "ir", "hr"] as PointTable[]) {
      const p = this.def.points[t].find((x) => x.signal === signal);
      if (p) return { table: t, point: p };
    }
    return undefined;
  }

  hasSignal(signal: string): boolean {
    return !!this.find(signal);
  }

  modbus(req: ModbusRequest): ModbusReply {
    const count = req.count ?? 1;
    const read = (t: PointTable): ModbusReply => {
      if (count < 1 || count > 125) return { ok: false, exception: 3 };
      const values: number[] = [];
      for (let a = req.addr; a < req.addr + count; a++) {
        const p = this.pointAt(t, a);
        if (!p) return { ok: false, exception: 2 };
        values.push(this.model.get(p.signal));
      }
      return { ok: true, values };
    };
    const write = (t: "coil" | "hr", values: number[] | undefined): ModbusReply => {
      if (!values || values.length === 0) return { ok: false, exception: 3 };
      const targets: SitePoint[] = [];
      for (let i = 0; i < values.length; i++) {
        const p = this.pointAt(t, req.addr + i);
        if (!p) return { ok: false, exception: 2 };
        const v = values[i];
        if (!Number.isInteger(v) || (t === "coil" ? v !== 0 && v !== 1 : v < 0 || v > 65535)) return { ok: false, exception: 3 };
        targets.push(p);
      }
      for (let i = 0; i < targets.length; i++) if (!this.model.set(targets[i].signal, values[i])) return { ok: false, exception: 4 };
      return { ok: true, values };
    };
    switch (req.fc) {
      case 1:
        return read("coil");
      case 2:
        return read("di");
      case 3:
        return read("hr");
      case 4:
        return read("ir");
      case 5:
        return write("coil", req.values?.slice(0, 1));
      case 6:
        return write("hr", req.values?.slice(0, 1));
      case 15:
        return write("coil", req.values);
      case 16:
        return write("hr", req.values);
      case 43:
        return { ok: true, deviceId: { vendor: this.def.vendor, product: this.def.product, revision: this.def.revision } };
      default:
        return { ok: false, exception: 1 };
    }
  }
}
