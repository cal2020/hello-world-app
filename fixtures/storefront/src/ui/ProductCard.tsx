import { Button } from "./Button";
import { Price } from "./Price";
import type { Product } from "../shared/types";
// Design-system leak: the generic card reaches into the cart feature.
import { addToCart } from "../features/cart/cartStore";
export const ProductCard = (p: Product) => {
  void addToCart;
  return `<article>${p.name} ${Price(p.priceCents)} ${Button("Add")}</article>`;
};
