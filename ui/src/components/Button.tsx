import {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactNode,
} from "react";
import { Link, LinkProps } from "react-router-dom";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "quiet" | "danger";

const base =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded border px-3 text-[13px] font-medium no-underline outline-none focus-visible:ring-2 focus-visible:ring-accent/20 disabled:pointer-events-none disabled:opacity-45";

const variantClass: Record<Variant, string> = {
  primary:
    "border-accent bg-accent text-white hover:border-accent-hover hover:bg-accent-hover",
  secondary:
    "border-border bg-surface text-text hover:border-border-strong hover:bg-subtle",
  quiet: "border-transparent bg-transparent text-text-secondary hover:bg-subtle hover:text-text",
  danger:
    "border-border bg-surface text-danger hover:border-danger/40 hover:bg-danger-subtle",
};

export function Button({
  variant = "secondary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={cn(base, variantClass[variant], className)}
    />
  );
}

export function ActionLink({
  variant = "secondary",
  className,
  ...props
}: LinkProps & { variant?: Variant }) {
  return (
    <Link
      {...props}
      className={cn(base, variantClass[variant], className)}
    />
  );
}

export function ActionAnchor({
  variant = "secondary",
  className,
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  variant?: Variant;
  children: ReactNode;
}) {
  return (
    <a
      {...props}
      className={cn(base, variantClass[variant], className)}
    >
      {children}
    </a>
  );
}
