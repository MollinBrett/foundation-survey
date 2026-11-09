// DRAFT questions. Not yet approved by Brett. Edit here; the form and validation follow.

export type Question =
  | { id: string; kind: "multi"; text: string; options: string[]; max?: number; required: boolean }
  | { id: string; kind: "scale"; text: string; min: number; max: number; minLabel: string; maxLabel: string; allowDontKnow?: boolean; required: boolean }
  | { id: string; kind: "text"; text: string; maxLength: number; required: boolean };

export const INTRO =
  "Help us understand how the XRPL community sees the XRP Ledger Foundation. 10 questions, about 3 minutes. We verify you are a real community member. We do not link your name to your answers.";

export const QUESTIONS: Question[] = [
  {
    id: "participation",
    kind: "multi",
    text: "How do you take part in the XRPL? (choose all that apply)",
    options: [
      "Builder / developer",
      "Validator or node operator",
      "Business / institution",
      "Community member / holder",
      "Researcher / educator",
      "Other",
    ],
    required: true,
  },
  {
    id: "familiarity",
    kind: "scale",
    text: "How familiar are you with what the XRPL Foundation does?",
    min: 1, max: 5, minLabel: "Not at all", maxLabel: "Very",
    required: true,
  },
  {
    id: "what_we_do",
    kind: "text",
    text: "In one sentence, what do you think the Foundation does? (optional)",
    maxLength: 300,
    required: false,
  },
  {
    id: "impact",
    kind: "scale",
    text: "How would you rate the Foundation's overall impact on the XRPL ecosystem?",
    min: 1, max: 5, minLabel: "Very negative", maxLabel: "Very positive",
    required: true,
  },
  {
    id: "independence",
    kind: "scale",
    text: "How independent is the Foundation from any single company?",
    min: 1, max: 5, minLabel: "Not independent", maxLabel: "Fully independent",
    allowDontKnow: true,
    required: true,
  },
  {
    id: "transparency",
    kind: "scale",
    text: "How transparent is the Foundation about its decisions and funding?",
    min: 1, max: 5, minLabel: "Not transparent", maxLabel: "Very transparent",
    allowDontKnow: true,
    required: true,
  },
  {
    id: "priorities",
    kind: "multi",
    text: "What should the Foundation focus on most? (pick up to 3)",
    options: [
      "Network health and validators",
      "Protocol and amendments",
      "Security",
      "Developer docs and tools",
      "Grants",
      "Education",
      "Community events",
      "Governance",
    ],
    max: 3,
    required: true,
  },
  {
    id: "news_sources",
    kind: "multi",
    text: "Where do you hear Foundation news? (choose all that apply)",
    options: ["X", "Discord", "Slack", "Mattermost", "GitHub", "Website", "Newsletter", "Events", "Other"],
    required: true,
  },
  {
    id: "recommend",
    kind: "scale",
    text: "How likely are you to recommend getting involved with the Foundation?",
    min: 0, max: 10, minLabel: "Not at all likely", maxLabel: "Extremely likely",
    required: true,
  },
  {
    id: "start_stop_change",
    kind: "text",
    text: "What is one thing the Foundation should start, stop, or change? (optional)",
    maxLength: 1000,
    required: false,
  },
];

export const DONT_KNOW = "dont_know";

export type Answers = Record<string, string | string[] | number>;

/** Validate a form body against QUESTIONS. Returns clean answers or an error message. */
export function parseAnswers(form: Record<string, string | string[]>): { ok: true; answers: Answers } | { ok: false; error: string } {
  const answers: Answers = {};
  for (const q of QUESTIONS) {
    const raw = form[q.id];
    if (q.kind === "multi") {
      const values = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((v) => q.options.includes(v));
      const unique = [...new Set(values)];
      if (q.required && unique.length === 0) return { ok: false, error: `Please answer: ${q.text}` };
      if (q.max && unique.length > q.max) return { ok: false, error: `Pick at most ${q.max}: ${q.text}` };
      if (unique.length) answers[q.id] = unique;
    } else if (q.kind === "scale") {
      const v = Array.isArray(raw) ? raw[0] : raw;
      if (v === undefined || v === "") {
        if (q.required) return { ok: false, error: `Please answer: ${q.text}` };
        continue;
      }
      if (q.allowDontKnow && v === DONT_KNOW) {
        answers[q.id] = DONT_KNOW;
        continue;
      }
      const n = Number(v);
      if (!Number.isInteger(n) || n < q.min || n > q.max) return { ok: false, error: `Invalid answer: ${q.text}` };
      answers[q.id] = n;
    } else {
      const v = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
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
