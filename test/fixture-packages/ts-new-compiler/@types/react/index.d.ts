// A few of React's types, enough for the fixture.
export interface ReactElement {
    type: unknown;
    props: unknown;
}
export type ReactNode = ReactElement | string | number | boolean | null | undefined;
export interface DOMAttributes<T> {
    onClick?: (event: { target: T }) => void;
}
export interface HTMLAttributes<T> extends DOMAttributes<T> {
    id?: string;
    title?: string;
}
