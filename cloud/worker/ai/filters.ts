// A Live page filter from a description ("slow writes on checkout"). The model only fills in
// the dashboard's own filter schema (shared/filters.ts), and its answer is checked against it:
// the user then sees the conditions in the filter dialog, with how many queries they match,
// before saving anything.
import type { DraftFilterRequest } from '../../shared/api'
import { FIELD_KEYS, FIELD_SPECS, type FilterDraft, OPERATORS, type Operator, parseDraft } from '../../shared/filters.ts'
import { AiError, type ChatMessage, type JsonModel } from './model.ts'

const MAX_TEXT = 300
const MAX_RELEASES = 5

export const FILTER_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'A short name for the filter, 2 to 5 words in sentence case, like "Slow checkout writes".' },
    match: { type: 'string', enum: ['all', 'any'] },
    conditions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: FIELD_KEYS },
          op: { type: 'string', enum: Object.keys(OPERATORS) as Operator[] },
          // Numbers too: a model kept to strings by the schema can stall where it wants to write 100.
          value: { type: ['string', 'number'] },
        },
        required: ['field', 'op', 'value'],
      },
    },
  },
  required: ['name', 'match', 'conditions'],
} as const

/** The schema written out for the model: each field, its operators and its values. */
export function describeFields(): string {
  return FIELD_KEYS.map((key) => {
    const f = FIELD_SPECS[key]
    const values =
      f.input.kind === 'choice'
        ? `one of ${f.input.options.map((o) => `"${o.value}" (${o.label})`).join(', ')}`
        : f.input.kind === 'number'
          ? `a number of ${f.input.unit}`
          : 'text, matched without case'
    return `- ${key}: ${f.description}. Operators: ${f.ops.join(', ')}. Value: ${values}.`
  }).join('\n')
}

export function filterMessages(req: DraftFilterRequest): ChatMessage[] {
  const releases = (req.releases ?? []).slice(0, MAX_RELEASES)
  const system = `You turn a description into a filter over database statements an application ran.
A filter is a name, "match" ("all": every condition must hold, "any": one is enough) and conditions on these fields:
${describeFields()}
Operators: contains, not_contains, is, is_not (text and choices); gte (at least) and lte (at most) for numbers.
Use only these fields and values. "Slow" means duration gte 100 unless a number is given. "Writes" means type is_not "select"; "reads" means type is "select". A word like "checkout" or "orders" is a request contains condition, unless it's clearly a table, then sql contains.
${releases.length ? `Releases, newest first: ${releases.join(', ')}. "The last release" is ${releases[0]}.` : 'No releases are known.'}
Answer with JSON only.`
  return [
    { role: 'system', content: system },
    { role: 'user', content: req.text.trim().slice(0, MAX_TEXT) },
  ]
}

export async function draftFilter(model: JsonModel, req: DraftFilterRequest): Promise<FilterDraft> {
  const raw = await model.json({ messages: filterMessages(req), schema: FILTER_SCHEMA, maxTokens: 2000, temperature: 0.1 })
  const draft = parseDraft(raw)
  if (!draft) throw new AiError('bad_output', 'That couldn’t be turned into conditions. Try describing it another way.')
  return draft
}
