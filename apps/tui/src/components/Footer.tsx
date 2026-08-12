import { Box, Text } from "ink";

type Props = {
  paletteOpen: boolean;
};

export function Footer({ paletteOpen }: Props) {
  return (
    <Box paddingX={1}>
      <Text dimColor>
        {paletteOpen
          ? "Palette open, Esc to close"
          : "/ instruct · Ctrl+K palette · Tab panels · a/r decide · ! stop all · q quit"}
      </Text>
    </Box>
  );
}
