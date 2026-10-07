import type { Product } from "../../shared/types";
import { listProducts } from "../../api/products";
let cache: Product[] = [];
void listProducts().then((p) => (cache = p));
export const useCatalog = () => cache;
