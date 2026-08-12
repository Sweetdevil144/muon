"use client";

import { ChevronDown, Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  isExternalNavHref,
  mainNav,
  productMenu,
} from "@/lib/marketing-content";
import { BrandMark } from "./brand-mark";

export function MarketingNav() {
  const pathname = usePathname();
  const [productOpen, setProductOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobileProductOpen, setMobileProductOpen] = useState(false);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setProductOpen(false);
        setMobileOpen(false);
        setMobileProductOpen(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);

  return (
    <header className="sticky top-0 z-50 border-b-2 border-[var(--bauhaus-ink)] bg-[color:var(--bauhaus-paper)/0.94] backdrop-blur-xl">
      <div className="mx-auto flex h-[4.75rem] max-w-7xl items-center justify-between px-4 sm:px-6">
        <BrandMark />

        <nav
          aria-label="Primary navigation"
          className="hidden items-center gap-1 lg:flex"
        >
          <div className="relative flex items-center">
            <Link
              aria-current={pathname.startsWith("/product") ? "page" : undefined}
              className="bauhaus-nav-link"
              href="/product"
            >
              Product
            </Link>
            <button
              aria-controls="product-menu"
              aria-expanded={productOpen}
              aria-label={`${productOpen ? "Close" : "Open"} product menu`}
              className="ml-[-0.35rem] grid size-9 place-items-center border-2 border-transparent transition hover:border-[var(--bauhaus-ink)] focus-visible:border-[var(--bauhaus-ink)]"
              onClick={() => setProductOpen((open) => !open)}
              type="button"
            >
              <ChevronDown
                aria-hidden="true"
                className={`size-4 transition-transform ${productOpen ? "rotate-180" : ""}`}
              />
            </button>

            {productOpen ? (
              <div
                className="absolute left-0 top-[calc(100%+1.25rem)] w-[42rem] border-2 border-[var(--bauhaus-ink)] bg-[var(--bauhaus-paper)] shadow-[10px_10px_0_var(--bauhaus-ink)]"
                id="product-menu"
              >
                <div className="grid grid-cols-2">
                  {productMenu.map((group, groupIndex) => (
                    <div
                      className={`p-5 ${groupIndex === 0 ? "border-r-2 border-[var(--bauhaus-ink)]" : ""}`}
                      key={group.label}
                    >
                      <p className="mb-3 text-[0.68rem] font-black uppercase tracking-[0.22em] text-black/50">
                        {group.label}
                      </p>
                      <div className="grid gap-1">
                        {group.items.map((item) => (
                          <Link
                            className="group grid grid-cols-[0.65rem_1fr] gap-3 p-3 transition hover:bg-white focus-visible:bg-white"
                            href={item.href}
                            key={item.href}
                          >
                            <span
                              aria-hidden="true"
                              className="mt-1.5 size-2.5 rounded-full bg-[var(--bauhaus-red)] transition-transform group-hover:scale-125"
                            />
                            <span>
                              <span className="block text-sm font-black uppercase tracking-[0.06em]">
                                {item.title}
                              </span>
                              <span className="mt-1 block text-sm leading-5 text-black/60">
                                {item.description}
                              </span>
                            </span>
                          </Link>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          {mainNav
            .slice(1)
            .filter((item) => item.label !== "Talk to Founder")
            .map((item) => (
            <Link
              aria-current={
                !isExternalNavHref(item.href) && pathname === item.href
                  ? "page"
                  : undefined
              }
              className="bauhaus-nav-link"
              href={item.href}
              key={item.href}
              {...(isExternalNavHref(item.href)
                ? { target: "_blank", rel: "noopener noreferrer" }
                : {})}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <Link
            className="hidden border-2 border-[var(--bauhaus-ink)] bg-white px-4 py-2 text-xs font-black uppercase tracking-[0.12em] shadow-[4px_4px_0_var(--bauhaus-ink)] transition hover:-translate-y-0.5 hover:shadow-[6px_6px_0_var(--bauhaus-ink)] md:inline-flex"
            href="https://cal.com/abhinavpandey/30min"
            rel="noopener noreferrer"
            target="_blank"
          >
            Talk to Founder
          </Link>
          <Link
            className="hidden border-2 border-[var(--bauhaus-ink)] bg-[var(--bauhaus-yellow)] px-4 py-2 text-xs font-black uppercase tracking-[0.12em] shadow-[4px_4px_0_var(--bauhaus-ink)] transition hover:-translate-y-0.5 hover:shadow-[6px_6px_0_var(--bauhaus-ink)] sm:inline-flex"
            href="/download"
          >
            Install app
          </Link>
          <button
            aria-controls="mobile-menu"
            aria-expanded={mobileOpen}
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
            className="grid size-11 place-items-center border-2 border-[var(--bauhaus-ink)] bg-white lg:hidden"
            onClick={() => setMobileOpen((open) => !open)}
            type="button"
          >
            {mobileOpen ? (
              <X aria-hidden="true" className="size-5" />
            ) : (
              <Menu aria-hidden="true" className="size-5" />
            )}
          </button>
        </div>
      </div>

      {mobileOpen ? (
        <nav
          aria-label="Mobile navigation"
          className="border-t-2 border-[var(--bauhaus-ink)] bg-[var(--bauhaus-paper)] px-4 py-5 lg:hidden"
          id="mobile-menu"
        >
          <div className="mx-auto grid max-w-7xl">
            <div className="flex items-center justify-between border-b border-black/20">
              <Link className="bauhaus-mobile-link flex-1" href="/product">
                Product
              </Link>
              <button
                aria-expanded={mobileProductOpen}
                aria-label={`${mobileProductOpen ? "Close" : "Open"} mobile product menu`}
                className="grid size-12 place-items-center"
                onClick={() => setMobileProductOpen((open) => !open)}
                type="button"
              >
                <ChevronDown
                  className={`size-5 transition-transform ${mobileProductOpen ? "rotate-180" : ""}`}
                />
              </button>
            </div>
            {mobileProductOpen ? (
              <div className="grid border-b-2 border-[var(--bauhaus-ink)] bg-white p-2 sm:grid-cols-2">
                {productMenu.flatMap((group) =>
                  group.items.map((item) => (
                    <Link
                      className="p-3 text-sm font-bold hover:bg-[var(--bauhaus-yellow)]"
                      href={item.href}
                      key={item.href}
                    >
                      {item.title}
                    </Link>
                  ))
                )}
              </div>
            ) : null}
            {mainNav.slice(1).map((item) => (
              <Link
                className="bauhaus-mobile-link"
                href={item.href}
                key={item.href}
                {...(isExternalNavHref(item.href)
                  ? { target: "_blank", rel: "noopener noreferrer" }
                  : {})}
              >
                {item.label}
              </Link>
            ))}
            <Link
              className="mt-5 border-2 border-[var(--bauhaus-ink)] bg-[var(--bauhaus-blue)] px-5 py-4 text-center text-sm font-black uppercase tracking-[0.12em] text-white"
              href="/download"
            >
              Install app
            </Link>
          </div>
        </nav>
      ) : null}
    </header>
  );
}
