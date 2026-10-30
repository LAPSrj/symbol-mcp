export function formatPrice(cents: number): string {
	return cents < 0 ? `-${formatPrice(-cents)}` : String(cents);
}
