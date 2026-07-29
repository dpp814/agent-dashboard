// Grok wraps the user prompt in <user_query> tags in hook payloads.
export function stripGrokUserQueryTags(text: string): string {
  return text
    .replace(/^<user_query>\s*/i, '')
    .replace(/\s*<\/user_query>$/i, '')
    .trim();
}

export function cleanTaskText(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  return stripGrokUserQueryTags(text) || undefined;
}
