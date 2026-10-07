import { CatalogPage } from "../features/catalog/CatalogPage";
import { CartPage } from "../features/cart/CartPage";
import { CheckoutPage } from "../features/checkout/CheckoutPage";
import { AccountPage } from "../features/account/AccountPage";
import { SearchPage } from "../features/search/SearchPage";
export interface Route { path: string; page: () => string }
export const routes: Route[] = [
  { path: "/", page: CatalogPage },
  { path: "/cart", page: CartPage },
  { path: "/checkout", page: CheckoutPage },
  { path: "/account", page: AccountPage },
  { path: "/search", page: SearchPage },
];
