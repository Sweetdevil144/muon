import type { ComponentType, CSSProperties, JSX } from "react";
import { isVendorId, type VendorId } from "@muon/client/vendors";
// Deep Mono imports — pure React SVGs, no Ant Design / @lobehub/ui peers.
// See https://lobehub.com/icons/skill.md (@lobehub/icons).
import ClaudeCodeMono from "@lobehub/icons/es/ClaudeCode/components/Mono.js";
import CodexMono from "@lobehub/icons/es/Codex/components/Mono.js";
import CursorMono from "@lobehub/icons/es/Cursor/components/Mono.js";
import OpenCodeMono from "@lobehub/icons/es/OpenCode/components/Mono.js";
import OpenAIMono from "@lobehub/icons/es/OpenAI/components/Mono.js";

/**
 * Per-vendor glyphs via `@lobehub/icons`. CSP-safe inline SVG (no network).
 */

const DEFAULT_SIZE = 14;

type LobeIcon = ComponentType<{
  size?: number | string;
  style?: CSSProperties;
  className?: string;
}>;

/**
 * WAVE D: the vendor half is a TOTAL `Record<VendorId, LobeIcon | null>`, so a
 * new vendor must state whether it has a mark. `null` is a statement — the
 * fallback diamond below — not an omission.
 */
const LOBE_BY_VENDOR_ID: Record<VendorId, LobeIcon | null> = {
  "claude-code": ClaudeCodeMono as LobeIcon,
  // Codex brand mark for the Codex lane; OpenAI for generic openai keys.
  codex: CodexMono as LobeIcon,
  cursor: CursorMono as LobeIcon,
  // Scout lane AND human terminal tab. (`opencode` once also lived in the
  // desktop's separate takeover/attach namespace; it left that table when it
  // became a managed lane — the registry is its only keyspace now.)
  opencode: OpenCodeMono as LobeIcon,
  // The dev/test double has no brand; the neutral diamond is correct for it.
  fake: null,
};

/**
 * PROVIDER keys and legacy aliases, a different keyspace from the vendor ids
 * above. A topology node or a token-usage row can be keyed by provider, so these
 * resolve too — but they are not vendors and must not be confused for them.
 */
const LOBE_BY_PROVIDER: Record<string, LobeIcon> = {
  claude: ClaudeCodeMono as LobeIcon,
  anthropic: ClaudeCodeMono as LobeIcon,
  openai: OpenAIMono as LobeIcon,
};

/**
 * `vendor` is UNTRUSTED. `isVendorId` is an explicit allowlist test, and the
 * provider lookup keeps `Object.hasOwn` — a raw index would reach the OBJECT
 * PROTOTYPE (see `VendorIcon` below for what that does to the window).
 */
function lobeIconFor(vendor: string): LobeIcon | null | undefined {
  if (isVendorId(vendor)) {
    return LOBE_BY_VENDOR_ID[vendor];
  }
  return Object.hasOwn(LOBE_BY_PROVIDER, vendor)
    ? LOBE_BY_PROVIDER[vendor]
    : undefined;
}

/** Unknown/future vendor — a plain diamond outline, visually neutral. */
function FallbackGlyph(props: { size: number }): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      className="vendor-icon"
      focusable="false"
      height={props.size}
      viewBox="0 0 16 16"
      width={props.size}
    >
      <path
        d="M8 1.4 14.6 8 8 14.6 1.4 8Z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.3"
      />
    </svg>
  );
}

/**
 * A small inline vendor glyph. Purely decorative (`aria-hidden`): call sites
 * keep their own text label/aria-label as the accessible name.
 *
 * `vendor` is UNTRUSTED here — the topology panel pipes brain-response strings
 * (`binding.vendor`, `heldByVendor`, `fromVendor`, `participant.vendor`)
 * straight in. A plain `TABLE[vendor]` index would therefore reach the OBJECT
 * PROTOTYPE: `"constructor"` yields a function React renders as a child
 * ("Objects are not valid as a React child") and `"__proto__"` yields
 * Object.prototype ("Element type is invalid") — both throw past this component
 * and blank the whole window. `lobeIconFor` is what keeps an unknown string a
 * diamond instead of a white screen: an allowlist test for a vendor id, and
 * `Object.hasOwn` for the provider aliases.
 */
export function VendorIcon(props: {
  vendor: string;
  size?: number;
}): JSX.Element {
  const size = props.size ?? DEFAULT_SIZE;
  const Icon = lobeIconFor(props.vendor);
  if (!Icon) {
    return <FallbackGlyph size={size} />;
  }
  return (
    <span aria-hidden="true" className="vendor-icon-wrap">
      <Icon
        className="vendor-icon"
        size={size}
        style={{ flex: "none", display: "block", color: "currentColor" }}
      />
    </span>
  );
}
