import Link from "next/link";

export function BrandMark({ inverse = false }: { inverse?: boolean }) {
  return (
    <Link
      aria-label="MUON home"
      className="group inline-flex items-center gap-3"
      href="/"
    >
      <img
        alt="MUON"
        className="size-9"
        height={36}
        src={inverse ? "/muon-mark-inverse.svg" : "/muon-mark.svg"}
        width={36}
      />
      <span
        className={`text-sm font-black tracking-[0.18em] ${
          inverse ? "text-white" : "text-[var(--bauhaus-ink)]"
        }`}
      >
        MUON
      </span>
    </Link>
  );
}
