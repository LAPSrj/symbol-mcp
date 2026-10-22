import type { HTMLAttributes, ReactNode } from "react";

export interface ChipProps extends HTMLAttributes<HTMLDivElement> {
	label: string;
	icon?: ReactNode;
}

/** Props that extend a React type: its props are summarized under the base type's name. */
export const Chip = ({ label }: ChipProps): PanelElement => ({ node: label });

export interface TagProps {
	text: string;
}

/** Props intersected with a React type: the signature already names it. */
export const Tag = (props: TagProps & HTMLAttributes<HTMLSpanElement>): PanelElement => ({ node: props.text });

export interface PanelElement {
	node: string;
}

export interface PanelResult {
	ok: boolean;
}

/** A component: its return type isn't defined under types:. */
export const Panel = ({ title }: { title: string }): PanelElement => ({ node: title });

export interface ToolbarProps {
	label: string;
	onChange?: (values: Partial<ToolbarProps>) => void;
}

/** Props are an intersection with a named member that a field refers to again. */
export const Toolbar = (props: ToolbarProps & { extra?: number }): PanelElement => ({ node: props.label });

/** A function: its return type is. */
export function loadPanel(id: number): PanelResult {
	return { ok: id > 0 };
}
