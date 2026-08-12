import { flattenDangerous, terminalSafe } from "@muon/client";
import { Box, Text } from "ink";
import type { ActionForm } from "../lib/actions.js";
import { hub, panelBorder } from "../lib/theme.js";

type Props = {
  form: ActionForm;
  values: Record<string, string>;
  fieldIndex: number;
  error: string | null;
  busy: boolean;
  hint?: string;
};

export function FormPrompt({ form, values, fieldIndex, error, busy, hint }: Props) {
  return (
    <Box
      flexDirection="column"
      borderStyle={panelBorder}
      borderColor={hub.border}
      borderDimColor
      paddingX={1}
      width="80%"
    >
      <Text bold>{terminalSafe(form.title)}</Text>
      {form.fields.map((field, index) => {
        const active = index === fieldIndex;
        const value = values[field.id] ?? "";
        return (
          <Text key={field.id} color={active ? hub.focus : undefined} bold={active}>
            {/* The label is MUON's own, the VALUE is whatever was typed or
                pasted — a pasted bidi override would reorder this line. Live
                echo uses `flattenDangerous`, which does NOT trim, so a space
                you just typed still shows; `terminalSafe` would eat it. */}
            {active ? "›" : " "} {terminalSafe(field.label)}: {flattenDangerous(value)}
            {active ? <Text dimColor>_</Text> : null}
          </Text>
        );
      })}
      {hint ? <Text dimColor>{terminalSafe(hint)}</Text> : null}
      {/* The error is BACKEND and vendor text — `executeAction` puts a raw
          `error.message` here, and a lane-not-found error interpolates stored
          lane keys. This panel is modal and larger than the status line, so it
          was the more exposed half of the same defect. */}
      {error ? <Text color="red">{terminalSafe(error)}</Text> : null}
      {busy ? (
        <Text dimColor>Working…</Text>
      ) : (
        <Text dimColor>Enter next/submit · Esc cancel</Text>
      )}
    </Box>
  );
}
