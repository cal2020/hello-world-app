import { priceFor } from "../pricing/price";

export interface Order { sku: string; qty: number; total: number }

export function createOrder(sku: string, qty: number): Order {
  return { sku, qty, total: priceFor(sku) * qty };
}
