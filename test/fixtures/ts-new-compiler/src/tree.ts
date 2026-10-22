export interface Item {
	id: number;
	label?: string;
}

export interface Box<T> {
	value: T;
}

export type Pair = readonly [string, Item?];

export interface ItemList extends ReadonlyArray<Item> {}

export interface TreeNode {
	label: string;
	children: TreeNode[];
}

export function build(items: Item[], first: Box<string>, second: Box<number>, pair: Pair, list: ItemList, tree: TreeNode): void {
	void [items, first, second, pair, list, tree];
}
