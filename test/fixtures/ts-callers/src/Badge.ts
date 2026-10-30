import { formatPrice } from "./price";

export default function (cents: number): string {
	return `[${formatPrice(cents)}]`;
}
