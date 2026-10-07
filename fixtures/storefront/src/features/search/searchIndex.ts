import type { Product } from "../../shared/types";
import { listProducts } from "../../api/products";
let index: Product[] = [];
void listProducts().then((p) => (index = p));
export const search = (q: string) => index.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
