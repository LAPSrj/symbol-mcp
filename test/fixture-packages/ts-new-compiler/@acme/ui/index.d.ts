import { BadgeBase } from "./base";
export interface BadgeProps extends BadgeBase {
    tone?: "info" | "warning";
}
export declare const Badge: (props: BadgeProps) => JSX.Element;
