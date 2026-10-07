import { ProductCard } from "../../ui/ProductCard";
import { useCatalog } from "./useCatalog";
export const CatalogPage = () => useCatalog().map(ProductCard).join("");
