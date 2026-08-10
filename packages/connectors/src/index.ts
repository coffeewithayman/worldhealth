import type { Connector } from '@wd/core';
import { fredConnector } from './fred.js';
import { treasuryCurveConnector } from './treasury-curve.js';
import { treasuryAuctionsConnector } from './treasury-auctions.js';
import { ecbFxConnector } from './ecb-fx.js';
import { eiaConnector } from './eia.js';
import { lbmaMetalsConnector } from './lbma-metals.js';
import { coingeckoConnector } from './coingecko.js';
import { portwatchConnector } from './portwatch.js';
import { bisConnector } from './bis.js';
import { gdeltConnector } from './gdelt.js';

/**
 * The connector registry.
 *
 * Adding a data source means writing one module and appending it here — nothing
 * else in the system needs to change. Ordering is cosmetic (it drives CLI
 * output order), not semantic; connectors are independent and run concurrently.
 */
export const CONNECTORS: Connector[] = [
  fredConnector,
  treasuryCurveConnector,
  treasuryAuctionsConnector,
  ecbFxConnector,
  lbmaMetalsConnector,
  eiaConnector,
  coingeckoConnector,
  portwatchConnector,
  bisConnector,
  gdeltConnector,
];

export function getConnector(id: string): Connector | undefined {
  return CONNECTORS.find((c) => c.id === id);
}

export * from './util.js';
export { FRED_CATALOG } from './fred.js';
