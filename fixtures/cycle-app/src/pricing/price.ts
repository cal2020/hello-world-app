import { discountFor } from "./discount";

export function priceFor(sku: string): number {
  return 10 - discountFor(sku);
}
