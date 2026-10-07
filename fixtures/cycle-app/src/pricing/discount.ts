// Runtime cycle: discount -> order -> price -> discount
import { createOrder } from "../orders/order";
// Type-only edge: erased at runtime, not counted toward cycles by default
import type { Order } from "../orders/order";

export function discountFor(sku: string): number {
  return sku.startsWith("sku_") ? 1 : 0;
}

export function sample(): Order {
  return createOrder("sku_sample", 1);
}
