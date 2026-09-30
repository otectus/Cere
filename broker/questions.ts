import type { Approval, Question } from './types.ts';

export type Answers = Record<string, { answers: string[] }>;

/** Validate before resolving a request, so a failed form can be corrected in place. */
export function validateAnswers(approval: Approval, input: unknown): Answers {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Answer the requested questions');
  const answers = input as Answers;
  const questions = approval.questions || [];
  const allowed = new Set([...questions.map(q => q.id), ...Object.keys(approval.fields || {})]);
  if (Object.keys(answers).some(id => !allowed.has(id))) throw new Error('Answer only the requested questions');
  const clean: Answers = Object.create(null);
  for (const q of questions) {
    const supplied = Object.hasOwn(answers, q.id) ? answers[q.id]?.answers : undefined;
    if (supplied === undefined && q.required === false) continue;
    if (!Array.isArray(supplied) || supplied.length > 32 || supplied.some(v => typeof v !== 'string' || v.length > 100000)) throw new Error(`Enter an answer for ${q.header || q.question}`);
    const values = supplied.filter(v => v.trim().length > 0);
    if (q.required !== false && !values.length) throw new Error(`Answer ${q.header || q.question}`);
    if (!q.multiSelect && values.length > 1) throw new Error(`Choose one answer for ${q.header || q.question}`);
    if (new Set(values).size !== values.length) throw new Error('Choose each answer only once');
    if (q.allowOther === false && values.some(v => !q.options?.some(o => o.label === v))) throw new Error(`Choose a listed answer for ${q.header || q.question}`);
    if (values.length) clean[q.id] = { answers: values };
  }
  for (const [key, field] of Object.entries(approval.fields || {})) {
    const values = clean[key]?.answers;
    if (!values?.length && questions.find(q => q.id === key)?.required === false) continue;
    const value = values?.[0];
    if (field.type === 'array') {
      if (!values || field.minItems != null && values.length < field.minItems || field.maxItems != null && values.length > field.maxItems || field.items?.enum && values.some(v => !field.items.enum.includes(v))) throw new Error(`Choose valid answers for ${key}`);
    }
    if (field.type === 'boolean' && !['true', 'false'].includes(value)) throw new Error(`${key} must be true or false`);
    if (['number', 'integer'].includes(field.type)) {
      const n = Number(value);
      if (!value?.trim() || !Number.isFinite(n) || field.type === 'integer' && !Number.isInteger(n) || field.minimum != null && n < field.minimum || field.maximum != null && n > field.maximum) throw new Error(`Invalid number for ${key}`);
    }
    const listed = (v: unknown) => values?.every(answer => (v as unknown[]).some(option => String(option) === answer));
    if (field.enum && !listed(field.enum)) throw new Error(`Choose a listed value for ${key}`);
    if (field.oneOf && !listed(field.oneOf.map((v: any) => v.const))) throw new Error(`Choose a listed value for ${key}`);
    if (field.type === 'string' && value !== undefined && (field.minLength != null && value.length < field.minLength || field.maxLength != null && value.length > field.maxLength)) throw new Error(`Invalid answer length for ${key}`);
  }
  return clean;
}

/** Claude expects answers keyed by the original question text, not the UI ID. */
export function claudeQuestions(input: any): Question[] {
  if (!Array.isArray(input?.questions) || !input.questions.length || input.questions.length > 32) throw new Error('Claude supplied an invalid question form');
  const seen = new Set<string>();
  return input.questions.map((q: any, index: number) => {
    if (typeof q.question !== 'string' || !q.question.trim() || seen.has(q.question)) throw new Error('Claude supplied an invalid or duplicate question');
    seen.add(q.question);
    if (q.options !== undefined && (!Array.isArray(q.options) || q.options.some((o: any) => !o || typeof o.label !== 'string' || !o.label.trim()))) throw new Error('Claude supplied invalid question options');
    return { id: `question-${index}`, question: q.question, header: typeof q.header === 'string' ? q.header : undefined,
      options: q.options?.map((o: any) => ({ label: o.label, description: typeof o.description === 'string' ? o.description : undefined })),
      multiSelect: q.multiSelect === true, isSecret: q.isSecret === true, allowOther: true, required: true };
  });
}
