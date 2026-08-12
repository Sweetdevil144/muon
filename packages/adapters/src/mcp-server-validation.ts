type NamedMcpServer = {
  readonly name: string;
};

export function assertUniqueMcpServerNames(
  servers: readonly NamedMcpServer[]
): void {
  const names = new Set<string>();
  for (const server of servers) {
    if (names.has(server.name)) {
      const identifier = server.name
        .replace(/[^A-Za-z0-9_.-]/g, "?")
        .slice(0, 48);
      throw new Error(`Duplicate MCP server name '${identifier}'.`);
    }
    names.add(server.name);
  }
}
