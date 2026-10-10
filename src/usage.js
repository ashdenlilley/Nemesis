// Token accounting across requests. Handles Anthropic and OpenAI usage field names.
export function createUsage() {
  const totals = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    add(usage) {
      if (!usage) return;
      totals.requests++;
      totals.input += usage.input_tokens ?? usage.prompt_tokens ?? 0;
      totals.output += usage.output_tokens ?? usage.completion_tokens ?? 0;
      totals.cacheRead += usage.cache_read_input_tokens ?? 0;
      totals.cacheWrite += usage.cache_creation_input_tokens ?? 0;
    },
    totals: () => ({ ...totals }),
    reset() {
      for (const k of Object.keys(totals)) totals[k] = 0;
    },
  };
}
