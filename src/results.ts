// KPI scoring. Deterministic and tested, so the reported numbers never depend on an agent's arithmetic.
//
// Rule (approved 2026-11-12): on every KPI question the top two answers (4, 5) are positive,
// the bottom two (1, 2) negative, the middle (3) neutral. "Don't know" is left out of the
// percentages and counted separately.
import { DONT_KNOW, FAMILIAR_MIN, HEADLINE_KPI, QUESTIONS, type Answers } from "./survey";
import { type Env, intVar } from "./env";
import { surveyWindow } from "./db";

export interface Tally {
  answered: number; // excludes "Don't know"
  positive: number;
  neutral: number;
  negative: number;
  dont_know: number;
  pct_positive: number | null; // of answered, one decimal; null when nobody answered
  pct_neutral: number | null;
  pct_negative: number | null;
  meets_target: boolean | null;
}

export interface KpiResult {
  id: string;
  question: string;
  headline: boolean;
  all: Tally;
  familiar: Tally; // respondents at least "Moderately familiar"
  by_role: Record<string, Tally>; // only roles with enough respondents
}

export interface Results {
  scoring: string;
  target_pct_positive: number;
  respondents: number;
  familiar_respondents: number;
  roles: { role: string; respondents: number; reported: boolean }[];
  min_group_report_size: number;
  kpis: KpiResult[];
}

const pct = (part: number, whole: number) => (whole === 0 ? null : Math.round((part / whole) * 1000) / 10);

export function tally(values: (string | number | undefined)[], target: number): Tally {
  let positive = 0, neutral = 0, negative = 0, dont_know = 0;
  for (const v of values) {
    if (v === DONT_KNOW) dont_know++;
    else if (typeof v !== "number") continue; // unanswered or malformed: not counted anywhere
    else if (v >= 4) positive++;
    else if (v === 3) neutral++;
    else negative++;
  }
  const answered = positive + neutral + negative;
  const p = pct(positive, answered);
  return {
    answered,
    positive,
    neutral,
    negative,
    dont_know,
    pct_positive: p,
    pct_neutral: pct(neutral, answered),
    pct_negative: pct(negative, answered),
    meets_target: p === null ? null : p >= target,
  };
}

export function computeResults(responses: Answers[], opts: { target: number; minGroup: number }): Results {
  const familiar = responses.filter((a) => typeof a.familiarity === "number" && a.familiarity >= FAMILIAR_MIN);
  const byRole = new Map<string, Answers[]>();
  for (const a of responses) {
    const role = typeof a.role === "string" ? a.role : "Not stated";
    byRole.set(role, [...(byRole.get(role) ?? []), a]);
  }
  const roles = [...byRole].map(([role, list]) => ({ role, respondents: list.length, reported: list.length >= opts.minGroup }));

  const kpis = QUESTIONS.filter((q) => q.kind === "rating" && q.kpi).map((q) => {
    const of = (list: Answers[]) => tally(list.map((a) => a[q.id]), opts.target);
    const by_role: Record<string, Tally> = {};
    for (const r of roles) if (r.reported) by_role[r.role] = of(byRole.get(r.role)!);
    return { id: q.id, question: q.text, headline: q.id === HEADLINE_KPI, all: of(responses), familiar: of(familiar), by_role };
  });

  return {
    scoring: "Positive = top two answers, negative = bottom two, neutral = middle. Don't know is excluded from percentages.",
    target_pct_positive: opts.target,
    respondents: responses.length,
    familiar_respondents: familiar.length,
    roles,
    min_group_report_size: opts.minGroup,
    kpis,
  };
}

// ---------- Loading from the database ----------


export interface FullResults extends Results {
  window: "before" | "open" | "closed";
  /** Each KPI recomputed with the removed (quarantined) responses put back, to show how much moderation moved it. */
  including_removed: { id: string; respondents: number; pct_positive: number | null; pct_negative: number | null }[];
  respondents_by_channel: Record<string, number>;
  quarantined_excluded: { category: string | null; n: number }[];
}

export async function loadResults(env: Env): Promise<FullResults> {
  const db = env.SURVEY_DB;
  const [all, quarantined, channels] = await db.batch([
    db.prepare("SELECT answers, status FROM responses"),
    db.prepare("SELECT status_category AS category, COUNT(*) AS n FROM responses WHERE status = 'quarantined' GROUP BY status_category"),
    db.prepare("SELECT channel, COUNT(*) AS n FROM responses WHERE status = 'accepted' GROUP BY channel"),
  ]);
  const rows = (all!.results as { answers: string; status: string }[]).map((r) => ({ a: JSON.parse(r.answers) as Answers, status: r.status }));
  const opts = { target: intVar(env.KPI_TARGET_PCT, 80), minGroup: intVar(env.MIN_GROUP_REPORT_SIZE, 30) };
  const results = computeResults(rows.filter((r) => r.status === "accepted").map((r) => r.a), opts);
  const everything = computeResults(rows.map((r) => r.a), opts);

  // Channels below the minimum are folded together so small groups cannot be singled out.
  const minChannel = intVar(env.MIN_CHANNEL_REPORT_SIZE, 5);
  const respondents_by_channel: Record<string, number> = {};
  let other = 0;
  for (const r of channels!.results as { channel: string; n: number }[]) {
    if (r.n >= minChannel) respondents_by_channel[r.channel] = r.n;
    else other += r.n;
  }
  if (other > 0) respondents_by_channel["other channels"] = other;

  return {
    window: surveyWindow(env),
    ...results,
    including_removed: everything.kpis.map((k) => ({
      id: k.id,
      respondents: everything.respondents,
      pct_positive: k.all.pct_positive,
      pct_negative: k.all.pct_negative,
    })),
    respondents_by_channel,
    quarantined_excluded: quarantined!.results as { category: string | null; n: number }[],
  };
}
