import { formatPrice } from "./price";

export function total(items: number[]): string[] {
	return items.map((item) => formatPrice(item));
}
