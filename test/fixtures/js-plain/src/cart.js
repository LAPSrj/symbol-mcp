import { formatPrice } from "./price.js";

export function total(items) {
	return formatPrice(
		items.reduce((sum, item) => sum + item.price, 0),
		{ currency: "EUR" },
	);
}
