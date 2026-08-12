"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "Overview" },
  { href: "/install", label: "Install" },
  { href: "/quickstart", label: "Quickstart" },
  { href: "/cli", label: "CLI reference" },
  { href: "/mcp", label: "MCP server" },
  { href: "/governance", label: "Governance" },
  { href: "/troubleshooting", label: "Troubleshooting" },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <nav className="sidebar" aria-label="Documentation">
      <div className="nav-group-label">Guide</div>
      <ul className="nav-list">
        {NAV_ITEMS.map((item) => {
          const active =
            item.href === "/"
              ? pathname === "/"
              : pathname === item.href || pathname?.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className="bauhaus-nav-link"
                aria-current={active ? "page" : undefined}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="sidebar-footer">
        <p>
          Local-first. Your code and keys stay on your machine, and you decide
          what ships.
        </p>
        <p style={{ marginTop: "0.6rem" }}>
          <a href="https://getmuon.com">getmuon.com</a>
        </p>
      </div>
    </nav>
  );
}
