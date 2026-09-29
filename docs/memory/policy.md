# Graph memory policy

Memory starts disabled. Existing Cere memory preferences govern normal chat capture and recall; collector permissions are separately opt-in in the graph inspector. Disabling capture preserves already-retained records. Explicit deletion uses the erasure workflow.

Extraction is configured as `gpt-oss:20b-cloud` for this implementation. Enabling memory with cloud extraction allowed permits eligible source text to go through the configured loopback Ollama server to Ollama Cloud. This is independent of cloud chat recall, which defaults off. The source's local-only restriction is checked again before cloud extraction. Turn off cloud extraction to prevent these requests; no alternate extraction model is silently substituted. Embedding defaults to `nomic-embed-text` at the conversation's saved Ollama server.

Collector defaults disable Hyprland, Kitty, Fish, filesystem events, titles, file content, and retained workspace history. Approved roots are explicit paths; CWD/file metadata checks use resolved paths to reject symlink escapes. Kitty environment, command line, scrollback, and title content are discarded by its parser. Fish never emits its command line. Metadata observations do not grant desktop-control permissions. The history toggle is reserved for completing durable workspace capture; current desktop observations remain transient.

Source witnesses are untrusted data. Strict DTOs reject unknown fields, unregistered predicates, invalid entity types, invalid temporal intervals, and fabricated quotations. Source trust distinguishes direct user statements, tool instrumentation, document claims, inference, and assistant summaries. A candidate proposal is not a verified fact, and repetition does not increase a stored confidence score.

Default raw-turn retention is 30 days; candidate retention is 7 days. Expiration removes full conversation recall copies and non-supporting witnesses while retaining exact evidence used by accepted assertions when `retain_evidence` is enabled. Explicit forgetting also removes permitted evidence and affected managed chat passages. Erasure and expiration have distinct audit reasons. The current erasure registry must be preserved independently of older backups.

The supported trust boundary is one OS user. The broker's administrative memory methods are available to that user's authorized local client; arbitrary SQL/Cypher and internal projection commits are not model tools. Same-user programs can already access the private profile. Private directories and credential files must retain their configured modes.

Remaining restrictions and incomplete source lifecycle behavior are listed in [implementation status](implementation-report.md). This publication is not a claim that the complete reference design has passed all release gates.
