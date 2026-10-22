export default function ({ size = "md" }: { size?: string }) {
	return { size } as unknown as JSX.Element;
}
