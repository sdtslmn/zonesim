import type { ProcessModelType } from "./model.js";
import { WATER_TANK } from "./water-tank.js";
import { GAS_COMPRESSOR } from "./gas-compressor.js";
import { DC_COOLING } from "./dc-cooling.js";
import { METRO_LINE } from "./metro-line.js";

export * from "./model.js";
export { WaterTank, WATER_TANK } from "./water-tank.js";
export { GasCompressor, GAS_COMPRESSOR } from "./gas-compressor.js";
export { DcCooling, DC_COOLING } from "./dc-cooling.js";
export { MetroLine, METRO_LINE } from "./metro-line.js";

/** Process models a site can use, by name. */
export const PROCESS_MODELS: Record<string, ProcessModelType> = {
  [WATER_TANK.model]: WATER_TANK,
  [GAS_COMPRESSOR.model]: GAS_COMPRESSOR,
  [DC_COOLING.model]: DC_COOLING,
  [METRO_LINE.model]: METRO_LINE,
};
