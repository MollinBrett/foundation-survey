import type { D1Migration } from "cloudflare:test";
import type { Env as SurveyEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends Omit<SurveyEnv, "TEST_MIGRATIONS"> {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
