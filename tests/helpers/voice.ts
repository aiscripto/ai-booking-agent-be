/**
 * Vapi needs each tool result as a single-line string, so the webhook answers with the result written as
 * JSON text. Tests read it back into an object here.
 */
export function toolResult(res: { body: { results?: Array<{ result: unknown }> } }): Record<string, any> {
  const raw = res.body.results?.[0]?.result;
  if (typeof raw !== 'string') throw new Error(`The tool result is not a string: ${JSON.stringify(raw)}`);
  if (raw.includes('\n')) throw new Error('The tool result must be on a single line.');
  return JSON.parse(raw);
}
