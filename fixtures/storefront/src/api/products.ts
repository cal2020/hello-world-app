import { get } from "./client";
import type { Product } from "../shared/types";
export const listProducts = () => get<Product[]>("/products");
export const getProduct = (id: string) => get<Product>(`/products/${id}`);
