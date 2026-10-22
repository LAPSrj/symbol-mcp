import leftPad from "left-pad";

/**
 * Format a price for display.
 *
 * @param {number} amount Amount in cents.
 * @param {{ currency?: string, showSymbol?: boolean }} [options] Display options.
 * @returns {string} The formatted price.
 */
export function formatPrice(amount, { currency = "USD", showSymbol = true } = {}) {
	const value = (amount / 100).toFixed(2);
	return showSymbol ? `${currency} ${leftPad(value, 8)}` : value;
}

export function untyped(a, b = 2) {
	return a + b;
}
