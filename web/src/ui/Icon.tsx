import type { CSSProperties } from "react";
const paths = {
  plus: "M12 5v14M5 12h14",
  chat: "M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0Z",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10H3Z",
  settings:
    "m12 3 2 3 3-.2.8 3.1L21 11l-1.8 2.6.2 3.1-3 .8L14 21l-2.5-1.8-3.1.2-.8-3L4 14l1.8-2.5-.2-3.1 3-.8ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
  panel: "M3 5h18v14H3ZM9 5v14M13 9h4M13 13h4",
  arrow: "M12 19V5m-6 6 6-6 6 6",
  stop: "M7 7h10v10H7Z",
  moon: "M20 15.8A9 9 0 0 1 8.2 4 9 9 0 1 0 20 15.8Z",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5",
  search: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm5 12L21 21",
  bot: "M8 5h8v2h3a2 2 0 0 1 2 2v10H3V9a2 2 0 0 1 2-2h3ZM8 11v3m8-3v3m-8 3h8",
  skill: "m12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3Z",
  network: "M12 3v7M5 14v7m14-7v7M5 14h14M12 10v4M9 3h6",
  link: "m9 15 6-6m-6-3 1-1a5 5 0 0 1 7 7l-1 1m-8-2-1 1a5 5 0 0 0 7 7l1-1",
  logout: "M9 4H4v16h5m5-12 4 4-4 4m-5-4h12",
  chevron: "m9 5 7 7-7 7",
  copy: "M9 4h11v13H9ZM5 8H3v13h11v-2",
  check: "m5 12 4 4L19 6",
  terminal: "m5 7 5 5-5 5m8 0h6",
  shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Zm-4 9 3 3 5-6",
  wrap: "M3 6h16M3 11h15a4 4 0 0 1 0 8h-5m3-3-3 3 3 3M3 16h5",
};
export type IconName = keyof typeof paths;
export function Icon({
  name,
  size = 18,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
