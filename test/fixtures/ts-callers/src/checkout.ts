import { total } from "./cart";

export const checkout = (items: number[]) => total(items).join(", ");

export class Page {
	render(): string {
		return checkout([1, 2]);
	}
}
