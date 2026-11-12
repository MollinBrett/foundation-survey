// Questions approved by Brett on 2026-11-12. This survey is the official 2026 KPI instrument.
// Keep the wording and the order fixed: later surveys must match for results to be comparable.

type FiveLabels = readonly [string, string, string, string, string];

export type Question =
  | { id: string; kind: "rating"; text: string; labels: FiveLabels; allowDontKnow: boolean; kpi: boolean }
  | { id: string; kind: "single"; text: string; options: readonly string[]; otherOption: string; otherMaxLength: number }
  | { id: string; kind: "text"; text: string; maxLength: number; required: boolean };

export const INTRO =
  "Help us understand how the XRPL community sees the XRP Ledger Foundation. 10 questions, about 3 minutes. We verify you are a real community member. We do not link your name to your answers.";

export const DONT_KNOW = "dont_know";
export const DONT_KNOW_LABEL = "Don't know enough to say";

const TRANSPARENCY: FiveLabels = [
  "Not at all transparent",
  "Slightly transparent",
  "Moderately transparent",
  "Very transparent",
  "Extremely transparent",
];

// Rating answers are stored as 1-5 in label order (1 = first label), or DONT_KNOW.
export const QUESTIONS: Question[] = [
  {
    id: "familiarity",
    kind: "rating",
    text: "How familiar are you with the work of the XRP Ledger Foundation?",
    labels: ["Not at all familiar", "Slightly familiar", "Moderately familiar", "Very familiar", "Extremely familiar"],
    allowDontKnow: false,
    kpi: false,
  },
  {
    id: "satisfaction",
    kind: "rating",
    text: "Overall, how satisfied or dissatisfied are you with the XRP Ledger Foundation?",
    labels: ["Very dissatisfied", "Somewhat dissatisfied", "Neither satisfied nor dissatisfied", "Somewhat satisfied", "Very satisfied"],
    allowDontKnow: true,
    kpi: true,
  },
  {
    id: "impact",
    kind: "rating",
    text: "Overall, how would you rate the Foundation's impact on the XRP Ledger ecosystem?",
    labels: ["Very negative", "Somewhat negative", "No real impact", "Somewhat positive", "Very positive"],
    allowDontKnow: true,
    kpi: true,
  },
  {
    id: "independence",
    kind: "rating",
    text: "How independent is the Foundation from Ripple?",
    labels: ["Not at all independent", "Slightly independent", "Moderately independent", "Very independent", "Completely independent"],
    allowDontKnow: true,
    kpi: true,
  },
  {
    id: "transparency_decisions",
    kind: "rating",
    text: "How transparent is the Foundation about how it makes decisions?",
    labels: TRANSPARENCY,
    allowDontKnow: true,
    kpi: true,
  },
  {
    id: "transparency_finances",
    kind: "rating",
    text: "How transparent is the Foundation about its finances?",
    labels: TRANSPARENCY,
    allowDontKnow: true,
    kpi: true,
  },
  {
    id: "listening",
    kind: "rating",
    text: "How well does the Foundation listen to input from the XRP Ledger community?",
    labels: ["Not at all well", "Slightly well", "Moderately well", "Very well", "Extremely well"],
    allowDontKnow: true,
    kpi: true,
  },
  {
    id: "leadership",
    kind: "rating",
    text: "How would you rate the performance of the Foundation's leadership team?",
    labels: ["Very poor", "Poor", "Neither good nor poor", "Good", "Very good"],
    allowDontKnow: true,
    kpi: true,
  },
  {
    id: "start_stop_change",
    kind: "text",
    text: "What is one thing the Foundation should start, stop, or change? (optional)",
    maxLength: 1000,
    required: false,
  },
  {
    id: "role",
    kind: "single",
    text: "Which one of these best describes your main role in the XRP Ledger ecosystem?",
    options: ["Validator or node operator", "Developer or builder", "Business, vendor or institution", "Community member or XRP holder"],
    otherOption: "Other",
    otherMaxLength: 100,
  },
];

/** The question whose % positive is the headline KPI. */
export const HEADLINE_KPI = "satisfaction";
/** Respondents at or above this familiarity answer count as "familiar" (3 = Moderately familiar). */
export const FAMILIAR_MIN = 3;

export type Answers = Record<string, string | number>;

function one(raw: string | string[] | undefined): string {
  return ((Array.isArray(raw) ? raw[0] : raw) ?? "").trim();
}

/** Validate a form body against QUESTIONS. Returns clean answers or an error message. */
export function parseAnswers(form: Record<string, string | string[]>): { ok: true; answers: Answers } | { ok: false; error: string } {
  const answers: Answers = {};
  for (const q of QUESTIONS) {
    const v = one(form[q.id]);
    if (q.kind === "rating") {
      if (!v) return { ok: false, error: `Please answer: ${q.text}` };
      if (q.allowDontKnow && v === DONT_KNOW) {
        answers[q.id] = DONT_KNOW;
        continue;
      }
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 5) return { ok: false, error: `Invalid answer: ${q.text}` };
      answers[q.id] = n;
    } else if (q.kind === "single") {
      if (!v) return { ok: false, error: `Please answer: ${q.text}` };
      if (v !== q.otherOption && !q.options.includes(v)) return { ok: false, error: `Invalid answer: ${q.text}` };
      answers[q.id] = v;
      if (v === q.otherOption) {
        const other = one(form[`${q.id}_other`]);
        if (other.length > q.otherMaxLength) return { ok: false, error: `Too long (max ${q.otherMaxLength} characters): ${q.text}` };
        if (other) answers[`${q.id}_other`] = other;
      }
    } else {
      if (q.required && !v) return { ok: false, error: `Please answer: ${q.text}` };
      if (v.length > q.maxLength) return { ok: false, error: `Too long (max ${q.maxLength} characters): ${q.text}` };
      if (v) answers[q.id] = v;
    }
  }
  return { ok: true, answers };
}

/** Normalized free text, for spotting copy-paste across responses. Empty string if no text. */
export function freeText(answers: Answers): string {
  return QUESTIONS.filter((q) => q.kind === "text")
    .map((q) => String(answers[q.id] ?? ""))
    .join(" ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
