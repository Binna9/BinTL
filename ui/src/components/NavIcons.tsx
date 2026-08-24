import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type NavIconName =
  | "overview"
  | "files"
  | "connections"
  | "query"
  | "extracts"
  | "jobs";

const paths: Record<NavIconName, ReactNode> = {
  overview: (
    <>
      <path d="M4 4.8h7.2v7.2H4V4.8Z" />
      <path d="M12.8 4.8H20v4.4h-7.2V4.8Z" />
      <path d="M12.8 11.2H20V20h-7.2v-8.8Z" />
      <path d="M4 14h7.2V20H4v-6Z" />
    </>
  ),
  files: (
    <>
      <path d="M7 3.8h6.1L18.2 9v11.2H7V3.8Z" />
      <path d="M13.1 3.8V9h5.1" />
      <path d="M9.4 13h5.2M9.4 16.2h3.6" strokeLinecap="round" />
    </>
  ),
  connections: (
    <>
      <ellipse cx="12" cy="6" rx="6.4" ry="2.3" />
      <path d="M5.6 6v4.4c0 1.27 2.86 2.3 6.4 2.3s6.4-1.03 6.4-2.3V6" />
      <path d="M5.6 12.6v4.3c0 1.27 2.86 2.3 6.4 2.3s6.4-1.03 6.4-2.3v-4.3" />
    </>
  ),
  query: (
    <>
      <path d="M5 6.4h14M5 12h8.5M5 17.6h11" strokeLinecap="round" />
      <path d="M16.2 10.4 20 12l-3.8 1.6" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  extracts: (
    <>
      <path d="M12 4v10.5" strokeLinecap="round" />
      <path d="M8.2 11.2 12 15l3.8-3.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.2 18.2h13.6" strokeLinecap="round" />
    </>
  ),
  jobs: (
    <>
      <circle cx="7.2" cy="7.2" r="2.4" />
      <circle cx="16.8" cy="7.2" r="2.4" />
      <circle cx="12" cy="16.6" r="2.4" />
      <path d="M9.3 8.5 10.6 14M14.7 8.5 13.4 14" strokeLinecap="round" />
    </>
  ),
};

export function NavIcon({
  name,
  className,
}: {
  name: NavIconName;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("size-[1.05em] shrink-0", className)}
    >
      <g stroke="currentColor" strokeWidth="1.7">
        {paths[name]}
      </g>
    </svg>
  );
}
