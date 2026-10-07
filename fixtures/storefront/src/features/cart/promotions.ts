import type { CartLine } from "../../shared/types";
export const promotionFor = (l: CartLine) => (l.qty >= 3 ? 500 : 0);
