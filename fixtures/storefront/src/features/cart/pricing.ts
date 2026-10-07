import type { CartLine } from "../../shared/types";
import { promotionFor } from "./promotions";
import { lines } from "./cartStore";
export const applyPromotions = (ls: CartLine[]) => ls.map((l) => ({ ...l, discount: promotionFor(l) }));
export const cartTotal = () => lines().reduce((n, l) => n + l.product.priceCents * l.qty - promotionFor(l), 0);
