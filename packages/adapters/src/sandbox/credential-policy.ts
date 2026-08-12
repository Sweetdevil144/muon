/**
 * Environment names that carry human/operator authority or operator-owned
 * integration credentials. They are shared by runner sanitization and dynamic
 * provider-key validation so neither boundary can drift.
 */
export const OPERATOR_TOKEN_ENV_VARS = [
  "MUON_API_TOKEN",
  "MUON_OPERATOR_TOKEN",
  "MUON_GITHUB_TOKEN",
  "MUON_GITHUB_REFRESH_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
] as const;
