import type { CartLine, Product } from "../../shared/types";
import { emit } from "../../shared/events";
import { applyPromotions } from "./pricing";
const state: CartLine[] = [];
export const lines = () => state;
export function addToCart(product: Product) {
  state.push({ product, qty: 1 });
  emit("cart:changed", applyPromotions(state));
}
