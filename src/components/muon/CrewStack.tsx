import { MessageSquare, Monitor, TerminalSquare } from "lucide-react";

import { BrandIcon } from "./BrandIcon";

const TOOLS = [
  {
    name: "Claude Code",
    category: "Build and lead",
    detail: "Plans, implements, reviews, and can lead a crew from its own chat.",
    tone: "bg-trust-human",
  },
  {
    name: "Codex",
    category: "Build and lead",
    detail: "Same strength for building and leading, from your own Codex session.",
    tone: "bg-trust-human",
  },
  {
    name: "Cursor",
    category: "Explore and review",
    detail: "Deep code exploration and sharp review passes, pointed where you need them.",
    tone: "bg-trust-crew",
  },
  {
    name: "OpenCode",
    category: "Explore",
    detail: "Fast reconnaissance that maps the terrain before the builders move.",
    tone: "bg-trust-crew",
  },
];

const SURFACES = [
  {
    icon: Monitor,
    name: "Desktop",
    status: "Full workspace",
    description: "The visual home for missions, the crew, memory, approvals and review.",
  },
  {
    icon: TerminalSquare,
    name: "Terminal",
    status: "Same control",
    description: "Run the same missions from the command line when you prefer the keyboard.",
  },
  {
    icon: MessageSquare,
    name: "Your AI chat",
    status: "Optional lead",
    description: "Connect Claude Code or Codex and let it lead the crew — you still approve.",
  },
];

export function CrewStack() {
  return (
    <section id="crew" className="border-t border-border py-20 lg:py-28">
      <div className="grid grid-cols-12 gap-8">
        <div className="col-span-12 lg:col-span-6">
          <p className="panel-label mb-3">Your tools, on clear jobs</p>
          <h2 className="mb-6 font-sans text-[1.75rem] font-semibold tracking-[-0.02em]">
            Keep the AI tools you already pay for.
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {TOOLS.map((tool) => (
              <div key={tool.name} className="panel p-4">
                <div className="mb-2 flex items-center gap-2.5">
                  <BrandIcon name={tool.name} className="size-[18px] text-foreground" />
                  <span className="font-sans text-sm font-semibold">{tool.name}</span>
                </div>
                <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  {tool.category}
                </div>
                <p className="text-[0.9375rem] leading-relaxed text-muted-foreground">
                  {tool.detail}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div className="col-span-12 lg:col-span-6">
          <p className="panel-label mb-3">Where you run it</p>
          <h2 className="mb-6 font-sans text-[1.75rem] font-semibold tracking-[-0.02em]">
            Same mission, three ways in.
          </h2>
          <div className="panel divide-y divide-border">
            {SURFACES.map((surface) => (
              <div key={surface.name} className="flex flex-col gap-1 p-5">
                <div className="flex items-center justify-between gap-4">
                  <span className="flex items-center gap-2.5 font-sans text-sm font-semibold">
                    <surface.icon className="size-[18px] text-muted-foreground" />
                    {surface.name}
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-trust-crew">
                    {surface.status}
                  </span>
                </div>
                <p className="text-[0.9375rem] leading-relaxed text-muted-foreground">
                  {surface.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
