import { Badge } from "@acme/ui";

export const badge = Badge;

interface BaseProps {
	/** Extra classes on the wrapper. */
	className?: string;
	id?: string;
}

export interface ImageRef {
	id: number | null;
	/** Alternative text. */
	alt?: string;
}

export interface LinkRef {
	href: string;
	label?: string;
}

export type CardProps = Omit<BaseProps, "id"> & {
	/** Card title. */
	title: string;
	tone?: "light" | "dark";
	onSelect?: (id: number) => void;
	image?: string | number | ImageRef;
	link?: LinkRef;
};

/** A clickable card. */
export const Card = ({ title, tone = "light", className = "" }: CardProps) => {
	return { title, tone, className } as unknown as JSX.Element;
};

export default Card;

declare global {
	namespace JSX {
		interface Element {}
	}
}
