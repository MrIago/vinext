"use client";

import Link, { type LinkProps } from "next/link";
import { useState, type ReactNode } from "react";

// Like Next.js's prefetch test fixtures, a Link mounts only once its checkbox
// is ticked, so a spec decides when its viewport prefetch starts.
export function LinkAccordion({
  href,
  prefetch,
  children,
}: {
  href: string;
  prefetch?: LinkProps["prefetch"];
  children: ReactNode;
}) {
  const [isVisible, setIsVisible] = useState(false);
  return (
    <div>
      <input
        type="checkbox"
        checked={isVisible}
        onChange={() => setIsVisible(!isVisible)}
        data-link-accordion={href}
      />
      {isVisible ? (
        <Link href={href} prefetch={prefetch}>
          {children}
        </Link>
      ) : (
        <span>{children} (link is hidden)</span>
      )}
    </div>
  );
}
