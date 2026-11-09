import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.SURVEY_DB, env.TEST_MIGRATIONS);
