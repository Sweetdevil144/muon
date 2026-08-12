export const forbiddenPublicTerms = [
  "fully autonomous",
  "production ready",
  "zero risk",
  "unlimited agents",
  "supports every provider",
  "general availability",
  "sqlite",
  "postgres",
  "redis",
  "docker",
  "kuzu",
  "hnsw",
  "embeddingcache",
  "bitemporal",
  "rebuildable graph projection",
  "task ledger",
  "handoff packet",
  "peer lane",
  "worker lane",
  "adapter",
  "brain",
] as const;

export const mainNav = [
  { label: "Product", href: "/product" },
  { label: "How it works", href: "/how-it-works" },
  { label: "Pricing", href: "/pricing" },
  { label: "Enterprise", href: "/enterprise" },
  { label: "Security", href: "/security" },
  { label: "FAQ", href: "/faq" },
  { label: "Docs", href: "https://docs.getmuon.com" },
  {
    label: "Talk to Founder",
    href: "https://cal.com/abhinavpandey/30min",
  },
] as const;

export function isExternalNavHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

export const productMenu = [
  {
    label: "Workspace",
    items: [
      {
        title: "Command center",
        description:
          "See the mission, who is working, what is blocked, and what needs your call.",
        href: "/product/command-center",
      },
      {
        title: "Shared memory",
        description:
          "Agents remember their own work and see what the rest of the crew already learned.",
        href: "/product/shared-memory",
      },
      {
        title: "Approvals",
        description:
          "Review the exact change and evidence before anything important goes through.",
        href: "/product/approvals",
      },
    ],
  },
  {
    label: "Coordination",
    items: [
      {
        title: "Handoffs",
        description:
          "Pass goals, results, and open questions to the next specialist without retelling the story.",
        href: "/product/handoffs",
      },
      {
        title: "Your AI tools",
        description:
          "Put Claude Code, Codex, Cursor, and OpenCode on clear jobs instead of competing windows.",
        href: "/product/agent-lanes",
      },
      {
        title: "Human control",
        description:
          "Pause, redirect, take over, or decide what ships. People keep the final say.",
        href: "/product/human-control",
      },
    ],
  },
] as const;

/** Buyer-facing tools with a verified role in the current product. */
export const crewStack = [
  "Claude Code",
  "Codex",
  "Cursor",
  "OpenCode",
] as const;

export const homeStory = {
  eyebrow: "Multi-agent software teams, under control",
  title: "Make your coding agents work as one.",
  intro:
    "You already have AI coding tools. The hard part is making them work together without becoming your full-time job. Give MUON one mission. It plans the work, keeps the crew aligned, and brings you back when a real decision is needed.",
  proof: [
    "Works with the tools you already use",
    "Shared context across the crew",
    "You approve what ships",
  ],
  explanation:
    "MUON handles the coordination so your engineers can lead instead of babysit.",
  capabilities: [
    {
      index: "01",
      title: "Assign the right work",
      description:
        "MUON turns a goal into clear jobs with owners, limits, and checkpoints before anyone starts coding.",
    },
    {
      index: "02",
      title: "Keep the crew aligned",
      description:
        "Agents get the context they need, see what teammates already tried, and avoid stepping on the same work.",
    },
    {
      index: "03",
      title: "Review one result",
      description:
        "You get one place to inspect the change, the checks, and the history before you decide it can land.",
    },
  ],
  trust: [
    {
      title: "Your work stays on your machine",
      description:
        "MUON runs locally. The core loop does not depend on sending your engineering process through someone else's cloud.",
    },
    {
      title: "Permission stays narrow",
      description:
        "Approvals cover a specific action for a specific job. Shipping and other high-impact steps always come back to a person.",
    },
    {
      title: "Delivery stays reviewable",
      description:
        "What changed, what was checked, and who decided stay attached to the mission so you are not reconstructing the story later.",
    },
  ],
  loopTitle: "Plan. Assign. Coordinate. Review.",
  loopDescription:
    "Start with one mission. MUON proposes the plan, runs the crew in safe copies of your project, and holds the result for your review.",
  closingCta: "Give your agents one mission. Let MUON run the crew.",
} as const;

export const operatingProof = [
  {
    number: "01",
    label: "Plan",
    title: "Turn a goal into clear jobs",
    description:
      "MUON records what you want done, breaks it into owned steps, and suggests who should do each part.",
  },
  {
    number: "02",
    label: "Assign",
    title: "Put the right tool on the right job",
    description:
      "Claude Code and Codex can build. Cursor and OpenCode help with exploration and review. Every job has limits and a clear owner.",
  },
  {
    number: "03",
    label: "Coordinate",
    title: "Keep everyone on the same page",
    description:
      "Shared memory, handoffs, and live updates move with the work so you are not copy-pasting between chat windows.",
  },
  {
    number: "04",
    label: "Review",
    title: "Decide with the full picture",
    description:
      "Your team reviews the change, the checks, and the trail before anything merges into the main project.",
  },
] as const;

export const surfaceProof = [
  {
    name: "Desktop",
    status: "Full workspace",
    description:
      "The visual home for missions, the crew, memory, approvals, and review in one place.",
  },
  {
    name: "Terminal",
    status: "Same control",
    description:
      "Run the same missions from the command line or a compact terminal UI when you prefer the keyboard.",
  },
  {
    name: "Your AI chat",
    status: "Optional lead",
    description:
      "Start Claude Code or Codex yourself, connect it to MUON, and let it lead the crew while you still approve what ships.",
  },
] as const;

export const integrationStatus = [
  {
    name: "Claude Code",
    category: "Build and lead",
    status: "Ready",
    detail:
      "Can plan, implement, review, and lead a MUON crew from its own chat when you connect it.",
    tone: "ready",
  },
  {
    name: "Codex",
    category: "Build and lead",
    status: "Ready",
    detail:
      "Same strength as Claude Code for building and leading. Connect it from your own Codex session when you want that workflow.",
    tone: "ready",
  },
  {
    name: "Cursor",
    category: "Explore and review",
    status: "Ready",
    detail:
      "Deep code exploration and sharp review passes, pointed exactly where the crew needs a second opinion.",
    tone: "ready",
  },
  {
    name: "OpenCode",
    category: "Explore",
    status: "Ready",
    detail:
      "Fast reconnaissance that maps the terrain and gathers context before the builders move.",
    tone: "ready",
  },
] as const;

type ProductPage = {
  eyebrow: string;
  title: string;
  intro: string;
  outcome: string;
  availability: string;
  evidence: readonly string[];
  points: readonly {
    title: string;
    description: string;
  }[];
};

export const productPages: Record<string, ProductPage> = {
  "command-center": {
    eyebrow: "Command center",
    title: "See the mission, the crew, and the decisions",
    intro:
      "One screen for the active mission, who owns each job, what is moving, what is waiting on you, and what already finished.",
    outcome:
      "Leads can answer what is happening without piecing it together from five terminals.",
    availability: "In the Desktop app",
    evidence: [
      "Live mission view",
      "Clear ownership",
      "Budgets and deadlines",
      "Approvals in context",
    ],
    points: [
      {
        title: "One story",
        description:
          "Follow the request from kickoff through each agent's work to the final review.",
      },
      {
        title: "Visible limits",
        description:
          "See how much parallel work is running before a small team turns into an unowned swarm.",
      },
      {
        title: "Review where the work lives",
        description:
          "Open changes, activity, and approval evidence from the same mission, not a separate monitoring tool.",
      },
    ],
  },
  "shared-memory": {
    eyebrow: "Shared memory",
    title: "Give every agent memory, and the crew a shared view",
    intro:
      "Each agent keeps notes for its own job. The crew also shares what matters so specialists are not starting from zero every time.",
    outcome:
      "You stop being the person who copies context between tools.",
    availability: "Desktop, CLI, and TUI",
    evidence: [
      "Personal agent memory",
      "Shared crew memory",
      "Scoped to your project",
      "You confirm what becomes lasting knowledge",
    ],
    points: [
      {
        title: "Personal and shared",
        description:
          "Agents remember their own thread and can see relevant progress from teammates.",
      },
      {
        title: "Nothing lasting by accident",
        description:
          "Proposed notes stay provisional until a person confirms them as durable knowledge.",
      },
      {
        title: "Local by default",
        description:
          "Memory stays on your machine. Optional local helpers can improve search, but the product still works without them.",
      },
    ],
  },
  approvals: {
    eyebrow: "Approvals",
    title: "Make every yes cover one clear action",
    intro:
      "When something needs a person, MUON shows what is being asked, why it matters, and the evidence behind it.",
    outcome:
      "You can move faster without handing agents a blank permission slip.",
    availability: "Desktop, CLI, and TUI",
    evidence: [
      "Exact action shown",
      "Evidence before yes",
      "Time-limited approvals",
      "Shipping always asks a person",
    ],
    points: [
      {
        title: "No fuzzy yes",
        description:
          "If the evidence is missing, stale, or incomplete, MUON will not let the approval go through.",
      },
      {
        title: "Remember only what you intend",
        description:
          "You can remember safe repeats for specific tools, not a global free pass.",
      },
      {
        title: "Merge is deliberate",
        description:
          "Landing work into your main project is a human decision by default, tied to the exact result under review. Turning on Full Auto for an agent grants that consent in advance. It is revocable, and every automatic approval is recorded with its subject.",
      },
    ],
  },
  handoffs: {
    eyebrow: "Handoffs",
    title: "Move work forward without rebuilding the brief",
    intro:
      "When one specialist finishes, the next one gets the goal, the result, the open questions, and what to do next.",
    outcome:
      "A new agent continues from real state instead of asking you to retell the history.",
    availability: "Across crew workflows",
    evidence: [
      "Goals and results travel together",
      "Open questions stay visible",
      "Checks and changed files stay attached",
      "Live updates can reach teammates mid-mission",
    ],
    points: [
      {
        title: "Intent stays attached",
        description:
          "The next agent gets why the work exists and what good looks like.",
      },
      {
        title: "Evidence travels forward",
        description:
          "What changed and what failed remains part of the handoff.",
      },
      {
        title: "Memory stays honest",
        description:
          "Agent claims do not become lasting crew knowledge until a person confirms them.",
      },
    ],
  },
  "agent-lanes": {
    eyebrow: "Your AI tools",
    title: "Give every tool a clear job",
    intro:
      "MUON puts Claude Code, Codex, Cursor, and OpenCode on explicit work with owners and limits, instead of leaving them as competing chat windows.",
    outcome:
      "Engineers lead through intent and review. Agents stop needing constant human relay.",
    availability:
      "Claude Code and Codex can build and lead. Cursor and OpenCode help explore and review.",
    evidence: [
      "Claude Code and Codex for building",
      "Cursor and OpenCode for exploration and review",
      "Safe copies of your project for agent work",
      "Optional second opinion from a different tool",
    ],
    points: [
      {
        title: "Roles match the work",
        description:
          "Building, exploring, and reviewing can be split so one tool is not pretending to do everything.",
      },
      {
        title: "Parallel work stays limited",
        description:
          "MUON keeps visible caps on how much can run at once and how long it can run.",
      },
      {
        title: "Honest tool differences",
        description:
          "Not every product gets the same powers. MUON says what each tool can do instead of claiming they are interchangeable.",
      },
    ],
  },
  "human-control": {
    eyebrow: "Human control",
    title: "Automate the busywork. Keep the accountability.",
    intro:
      "MUON can plan, assign, monitor, and brief the crew. People still own direction, sensitive approvals, and shipping.",
    outcome:
      "You stop being the message bus between agents, and you remain the person who decides what lands.",
    availability: "Desktop, terminal, and connected Claude or Codex chats",
    evidence: [
      "Stop one job or everything",
      "Redirect with a new brief",
      "Take over in the native tool when needed",
      "Ship only with consent you granted",
    ],
    points: [
      {
        title: "Intervene at the right level",
        description:
          "Pause one task, redirect a branch of work, or stop the whole crew when something goes wrong.",
      },
      {
        title: "Take over when judgment matters",
        description:
          "Open the native tool in the working copy when a person should drive for a stretch.",
      },
      {
        title: "Decide what ships",
        description:
          "Even when Claude or Codex is leading the crew, merge is your call by default, with the evidence in front of you, or a standing consent you explicitly switched on and can switch off.",
      },
    ],
  },
};

export const workflowSteps = [
  {
    number: "01",
    label: "Connect",
    title: "Make sure your tools are ready",
    command: "muon doctor",
    description:
      "MUON checks that your AI coding tools are installed and signed in, then tells you exactly what is missing.",
  },
  {
    number: "02",
    label: "Plan",
    title: "Give MUON one mission",
    command: "muon chat --workspace .",
    description:
      "Start from Desktop, the terminal, or a connected Claude or Codex chat. MUON turns the goal into jobs, owners, and review points.",
  },
  {
    number: "03",
    label: "Assign",
    title: "Launch the crew",
    command: "muon dispatch status --chat-id <chat-id>",
    description:
      "Agents work in safe copies of your project with budgets and ownership, while MUON tracks progress against the mission.",
  },
  {
    number: "04",
    label: "Coordinate",
    title: "Keep the crew in sync",
    command: "muon dispatch status",
    description:
      "Memory, updates, checks, and handoffs move with the work so you are not the relay between windows.",
  },
  {
    number: "05",
    label: "Review",
    title: "Decide what can land",
    command:
      "muon approve resolve --approval-id <id> --status approved",
    description:
      "You see the change, the checks, and the history before anything merges into your main project.",
  },
] as const;

export const pricingPlans = [
  {
    name: "Individual",
    status: "Free",
    price: "Free",
    description:
      "The MUON Desktop app is free for individual use. Run a local multi-agent crew with shared memory, approvals, and reviewable delivery on your own machine.",
    features: [
      "Free Desktop app for individual use",
      "Works with Claude Code and Codex",
      "Cursor and OpenCode for exploration and review",
      "Connect Claude or Codex from your own chat",
      "Shared crew memory on your machine",
      "Use your existing AI tool accounts and usage",
    ],
    cta: {
      label: "Install the app",
      href: "/download",
    },
  },
  {
    name: "Teams",
    status: "Contact sales",
    price: "Team pricing",
    description:
      "For engineering teams that want help evaluating rollout and a clearer commercial path. Tell us how your crew works today.",
    features: [
      "Everything in Individual",
      "Team evaluation and rollout discussion",
      "Desktop and terminal workflows",
      "Approvals, handoffs, checks, and merge review",
      "Guidance for review-heavy environments",
      "AI tool subscriptions stay separate",
    ],
    cta: {
      label: "Contact for team pricing",
      href: "/enterprise",
    },
  },
] as const;

export const faqItems = [
  {
    question: "What is MUON?",
    answer:
      "MUON is the layer that turns your AI coding tools into one crew. You give it a mission. It plans the work, keeps agents aligned, and brings you back when a real decision is needed.",
  },
  {
    question: "Is MUON another coding agent?",
    answer:
      "No. Claude Code, Codex, Cursor, and OpenCode still do the coding. MUON runs the team around them so your people are not stuck coordinating by hand.",
  },
  {
    question: "Which tools does MUON work with?",
    answer:
      "Claude Code and Codex build and lead. Cursor and OpenCode explore and review. MUON puts every tool in its strongest position.",
  },
  {
    question: "Do I stay in control?",
    answer:
      "Yes. MUON can plan and coordinate. Shipping, merges, and other high-impact steps wait for a person unless you explicitly grant standing consent with Full Auto. Even then, every decision is recorded and you can revoke it. You can also pause, redirect, or take over at any time.",
  },
  {
    question: "Will agents change my main project without asking?",
    answer:
      "No. Agent work happens in safe copies. Your main project stays clean until someone reviews the result and approves the merge.",
  },
  {
    question: "Can one AI review another AI's work?",
    answer:
      "Yes. MUON can send the finished work to a different tool for a second look, then route the findings back without you playing messenger.",
  },
  {
    question: "Where does my data live?",
    answer:
      "On your machine by default. MUON is built so the core engineering loop does not require a cloud control plane.",
  },
  {
    question: "Does MUON take my AI login credentials?",
    answer:
      "No. You sign into Claude, Codex, Cursor, and OpenCode the same way you already do. MUON checks readiness without storing those secrets.",
  },
  {
    question: "Where can I use MUON?",
    answer:
      "In the Desktop app, from the terminal, or by connecting Claude Code or Codex from a chat you start yourself. Same mission, same approvals, same history.",
  },
  {
    question: "How much does MUON cost?",
    answer:
      "The Desktop app is free for individuals. Team pricing is available through the enterprise form. Your AI tool subscriptions and usage stay separate.",
  },
  {
    question: "Is MUON generally available?",
    answer:
      "Yes. The macOS app is a free download at getmuon.com/download, and the CLI and TUI install with one command. New releases are announced to the early-access list first.",
  },
] as const;
