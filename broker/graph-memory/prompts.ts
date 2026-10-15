/**
 * Retrieval prompts that embedding models were trained with. A query and a stored passage
 * are embedded differently, and a model used without its prompts ranks noticeably worse: on
 * Cere's own conversations, prompting nomic-embed-text-v2-moe moved the median rank of each
 * question's answer from 9 to 6.
 *
 * - nomic-embed-text (every version): https://huggingface.co/nomic-ai/nomic-embed-text-v2-moe
 * - mxbai-embed-large: https://huggingface.co/mixedbread-ai/mxbai-embed-large-v1
 * - qwen3-embedding: https://github.com/QwenLM/Qwen3-Embedding (instruction on queries only)
 * - embeddinggemma: https://huggingface.co/blog/embeddinggemma
 *
 * Models without an entry are embedded as given.
 */
const templates: { name: string; pattern: RegExp; query: string; document: string }[] = [
  { name: "nomic", pattern: /(?:^|\/)nomic-embed-text(?:[-:]|$)/, query: "search_query: ", document: "search_document: " },
  { name: "mxbai", pattern: /(?:^|\/)mxbai-embed-large(?:[-:]|$)/, query: "Represent this sentence for searching relevant passages: ", document: "" },
  {
    name: "qwen3",
    pattern: /(?:^|\/)qwen3-embedding(?:[-:]|$)/,
    query: "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:",
    document: "",
  },
  { name: "gemma", pattern: /(?:^|\/)embeddinggemma(?:[-:]|$)/, query: "task: search result | query: ", document: "title: none | text: " },
];
/** The rule embeddings used before this table: nomic prompts for exactly `nomic-embed-text`. */
const original = /(?:^|\/)nomic-embed-text(?::|$)/;
/**
 * A model's prompts and the identity they give its embedding space. Spaces whose vectors this
 * table does not change keep their original identity, so their stored vectors stay valid; a model
 * that gains prompts gets a new space and is embedded again.
 */
export function embeddingPrompts(model: string) {
  const template = templates.find((entry) => entry.pattern.test(model));
  if (!template) return { id: "nomic-prefix-v1", query: "", document: "" };
  if (original.test(model)) return { id: "nomic-prefix-v1", query: template.query, document: template.document };
  return { id: `prompts-v2-${template.name}`, query: template.query, document: template.document };
}
