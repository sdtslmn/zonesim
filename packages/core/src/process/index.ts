import type { ProcessModelType } from "./model.js";
import { WATER_TANK } from "./water-tank.js";

export * from "./model.js";
export { WaterTank, WATER_TANK } from "./water-tank.js";

/** Process models a site can use, by name. */
export const PROCESS_MODELS: Record<string, ProcessModelType> = {
  [WATER_TANK.model]: WATER_TANK,
};
