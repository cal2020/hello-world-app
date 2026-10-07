import type { Product } from "../../shared/types";
export const byMaxPrice = (max: number) => (p: Product) => p.priceCents <= max;
