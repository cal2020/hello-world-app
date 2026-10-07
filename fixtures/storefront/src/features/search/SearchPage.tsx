import { ProductCard } from "../../ui/ProductCard";
import { search } from "./searchIndex";
export const SearchPage = () => search("").map(ProductCard).join("");
