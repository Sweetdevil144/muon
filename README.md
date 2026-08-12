# MUON

**The shared brain and code understanding that every coding agent plugs into.**

You already run Claude Code, Codex, Cursor, and OpenCode. MUON drives *your own
installed copies* as one small, governed crew, keeps a **human-confirmed memory**
and a **code graph** synchronized across them, and refuses to let any agent
merge, ship, or resize the crew without your recorded approval.

It is local-first and loopback-only. It never custodies a vendor token — it
drives your binary and your login. Every human gate fails closed.

Multi-vendor orchestration is table stakes. The part worth having is the dual
graph and the **impact-and-memory pre-edit gate**: before an agent edits a
symbol, MUON shows its blast radius *and* the decisions previously recorded
about it.

## Honest status

This project reports what has actually been observed, not what is implemented.

- The full real-vendor golden path — crew dispatch → edits → checks → handoff →
  gate → governed merge — is **not yet complete end to end**.
- Two live vendor probes exist. A read-only Codex turn passed through a real
  provider and MUON's own session driver, loopback brain, and MCP inventory.
  OpenCode's generated permission config was verified to *resolve* to a deny
  table — **enforcement at tool-call time has not been observed**.
- Cursor's managed read-only path has had **no live run**, and there is **no
  live Claude turn**.
- Broad green test counts in this repo are hermetic unless a run says otherwise.

If a claim here turns out to overstate what MUON does, that is a bug — please
open an issue.

## Install

```bash
curl -fsSL https://getmuon.com/install.sh | bash
```

macOS and Linux. That installs `muon` (the CLI, which auto-starts the local
brain — there is no server to run) and `muon-tui` (the full-screen terminal
cockpit). It needs Node.js 20+ and installs nothing else.

The **desktop app is macOS-only today** and is a separate download from
<https://getmuon.com/download>. The CLI and TUI are the whole product on Linux,
and they are not a lesser one — the terminal is the hero surface.

There is deliberately no Homebrew tap, apt repo, or other package-manager
recipe. One installer, one code path, nothing to drift out of step with a
release.

Or build from source:

```bash
npm install
./build.sh          # builds every workspace, in dependency order
muon doctor         # verifies the local brain and your agent CLI registration
```

## Quickstart

```bash
muon setup          # pick which agent CLIs MUON registers itself into
muon doctor         # confirm registration is healthy
muon               # the TUI
```

MUON registers itself as an MCP server in the agent CLIs you choose, so your
agents gain memory, code-impact, and coordination tools inside the tool you
already use.

## Surfaces

| Surface | What it is for |
|---|---|
| **Desktop** | The mission desk — sessions, review, gates, memory governance |
| **TUI** (`muon`) | Terminal-native daily driver; the terminal stays the hero |
| **CLI** (`muon <cmd>`) | Headless spine — dispatch, cost, crew, memory, handoff |
| **MCP** | What your agents actually hold: memory, impact, claims, findings |

## Licence — free for one person, licensed for a company crew

**Free, including at your job.** Personal projects, learning, research,
evaluation, hobby work, teaching, nonprofit use — and **your own work as an
individual engineer, even when that work is for your employer or a client.**
One person, on machines you operate, with your own agent-CLI logins. Use it,
read it, modify it, share it.

**Licensed when it becomes the company's brain.** The moment two or more
people's MUON instances are linked — sharing memory, coordinating work, running
as one crew across people — that is a commercial licence. Same for hosting MUON
as a service, or shipping it inside a paid product.

That is the whole line, and it is not arbitrary: it is the same line the
architecture draws. MUON is one brain per machine. What you pay for is making it
one brain per *company*.

Terms: [LICENSE](LICENSE) — **PolyForm Noncommercial 1.0.0** — plus the
[Individual Use Grant](ADDITIONAL-GRANT.md), which is what makes the "at your
job" part above true. Those two documents govern; this section is a
plain-English summary, not legal advice.

Commercial and company-wide licensing: **abhinavpandey1230@gmail.com**

To be accurate about a word people care about: this is **source-available**, not
OSI-approved open source. The source is public, you may read, modify and run it,
and you may do so at your job — what it does not grant is the company-wide crew.

## Contributing

Contributions are welcome. By opening a pull request you agree that your
contribution is licensed under the same terms as this project, and that it may
also be used in MUON's commercially licensed distribution.

Before a change lands it needs to pass the local verification this project runs
on itself:

```bash
npm run typecheck
npx vitest run              # from the workspace you touched
```

Tests that assert behaviour are expected to *fail when the behaviour is broken* —
if a test passes against a deliberately broken implementation, it is not yet a
test.
