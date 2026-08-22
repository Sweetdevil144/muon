export function MuonMark({ className = "size-6" }: { className?: string }) {
  return (
    <span className={`grid grid-cols-2 grid-rows-2 ${className}`} aria-hidden="true">
      <span className="bg-muon-blue" />
      <span className="rounded-tr-full bg-muon-red" />
      <span className="rounded-bl-full bg-muon-yellow" />
      <span className="bg-foreground/10" />
    </span>
  );
}
