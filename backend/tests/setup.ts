process.env.DATABASE_URL ??=
  "postgresql://postgres:postgres@localhost:5432/muon_test";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.FRONTEND_ORIGIN ??= "http://localhost:3050";
(process.env as Record<string, string | undefined>).NODE_ENV ??= "test";
process.env.PORT ??= "4000";
// The API tests assume an open API; auth.test.ts / capability-tiers.test.ts set
// the tokens explicitly. Clear ALL three tier credentials so every file starts
// in open mode (tier defaults to operator) unless it configures them itself.
delete process.env.MUON_API_TOKEN;
delete process.env.MUON_OPERATOR_TOKEN;
delete process.env.MUON_AGENT_TOKEN;
// Dense embeddings tier off by default in tests (KG-3): keep the suite
// deterministic and network-free, a dev's local vendor CLIs must never be probed.
// The KG-3 embeddings test opts back in by INJECTING a deterministic fake via
// __setEmbedderForTests (still no network).
process.env.MUON_EMBED_DISABLE ??= "1";
