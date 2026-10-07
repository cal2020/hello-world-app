import { config } from "./config";
import { round } from "./math";
export const formatMoney = (cents: number) => `${round(cents / 100, 2)} ${config.currency}`;
