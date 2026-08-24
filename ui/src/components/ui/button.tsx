import {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactNode,
} from "react";
import { Link, LinkProps } from "react-router-dom";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "quiet" | "danger";

const base = "ui-btn";

const variantClass: Record<Variant, string> = {
  primary: "ui-btn-primary",
  secondary: "ui-btn-secondary",
  quiet: "ui-btn-quiet",
  danger: "ui-btn-danger",
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
