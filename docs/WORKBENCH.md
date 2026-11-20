# The Workbench: files, images and analysis

The Workbench lets an Ollama or API conversation work with real files, images and analysis runs without a coding CLI. You can always use it yourself; three switches decide what the **model** is offered.

Open it with the folder button under the composer, **More › Workbench**, **Ctrl+Shift+W**, or the command palette (**Open Workbench**, **Browse project files**, **Review pending changes**, **Create image**, **Show artifacts**, **Show active runs**). In the expanded workspace it sits beside the chat and can be resized from its left edge. In the compact panel it replaces the conversation as one sheet; **Chat** returns to the conversation and **Escape** closes it.

The tabs are **Files**, **Preview**, **Changes**, **Images**, **Runs** and **Shelf**.

## What the model may use

**The model may use: Files · Images · Analysis** appears at the top of the Workbench and in **New conversation**. The switches apply to Ollama and API conversations only. Temporary conversations stay text-only, and a conversation controlled from a phone is offered no Workbench tools. The **Review** and **Plan** postures withhold changes, images and analysis for the turns they apply to.

- **Files** offers reading, searching, file citations, and change *proposals*. Every change waits for your review.
- **Images** offers generation, edits, deterministic transforms, inspection, OCR and image analysis through the backends you set up.
- **Analysis** offers isolated Python runs in Code Lab and commands that you approve each time.

Small models get a focused set of tools. Advanced tools, such as the review helper, are listed in a small catalog that the model must ask for first.

## Folders and permissions (Files)

Choose a folder with **Choose folder…** or keep a private **conversation workspace**. A conversation can have up to 8 folders. Each folder has its own permissions, set with the sliders button:

- **Create and edit text files**: always through a change you review.
- **Organize**: new folders, copy, move and trash, each set reviewed.
- **Include hidden files in listings and search**: credential files, version-control internals and Cere's own data are never read.
- **Run approved commands here (Analysis)**: lets Analysis commands use the folder as their working directory.
- **Who may process its contents**: models on this computer (the default), also models on your own servers, or also cloud services. A model whose processing location is not allowed cannot read the folder. Earlier excerpts from it are withheld from that model if you switch to it later.

Cere opens files through a small helper (`cere-workspacefs`) that refuses `..`, symlinks and paths outside the folder at the kernel level. If the helper is missing, the Files tab says so and file tools stay off.

**Browse** one folder level at a time. **Filter names** filters what is listed, and **Search contents** searches file text (literal, or **Regex** when `ripgrep` is installed). Results say when a search stopped early and why. **Preview** shows text with line numbers, renders Markdown, and shows the file's version. **Edit** turns the preview into an editor; **Review change** sends your edit to the same review as a model's proposal.

## Reviewing changes

A proposal opens in **Changes** with every operation listed: created, changed, moved, copied, trashed. Text changes include their diffs. **Accept all**, **Accept selected** or **Reject**. Cere checks each file's version before applying. If a file changed after the proposal was made, that operation is refused and nothing is overwritten. Results are shown per operation. A set can end as *applied*, *partially applied*, *failed* or *outcome unknown*.

**Undo…** creates a new review of the inverse operations. It restores from backups or Cere's private trash only where nothing changed since; where something did, the earlier content comes back as a copy beside it, so no newer edit is overwritten. Trashed files are kept privately (up to 512 MiB). A folder's **Edit permission** lets Cere apply small text edits there for a time and a number of operations you choose, without asking each time; moves, trash and commands are never covered. **Revoke** ends it.

## References in the composer (@)

Type **@** in the composer to reference a file or folder from this conversation's workspace, one of its files or images, a file shared with the project, a bound document collection, or another conversation in the same project. Use the arrow keys and Enter or Tab to pick, and Escape to close. A pick becomes a chip; the text keeps only `@name`. Under the chips, Cere shows roughly how much the references add, and any reason one could not be sent, before you send.

References are resolved when you send, never by reading paths out of your text:

- A **file** is read as it is at send time. If it changed after you picked it, the message notes that the current version was used.
- A **folder** contributes a list of its entries (up to 100), not its contents.
- A **document** (PDF, DOCX, XLSX) contributes extracted text with page, sheet and cell locations. An **image** is attached when the model can see images; otherwise the model is told to use the image tools.
- A **conversation** contributes its most recent messages, attributed and bounded. Text from a conversation that ran only on this computer is not sent to a cloud model.

A reference whose processing destination does not allow this conversation's model stops the send before anything is recorded, with the reason. Referenced content travels apart from your words, so a later model that may not receive it loses the content but keeps your message.

## Files the conversation keeps (artifacts)

Images, imports, extractions and Code Lab outputs are kept as **conversation files** (artifacts). Each version is immutable and identified by its content hash. The **Images** tab lists them, with **Images** or **All files** and filters by source.

- **Import…** keeps a private copy of a file and asks which destinations may process it.
- **Save as…** writes a copy anywhere you choose. When the model exports a file into a workspace folder, that is a reviewed change that never overwrites. Exported copies are not kept in sync.
- **Pin** keeps a file on the project **Shelf**. **Share with project** makes it findable from other conversations in the same project. Sharing does not add it to prompts.
- **Remove from conversation** forgets a file here. It can also remove what was made from it (extractions, OCR text, edits saved as new files). The stored copy and its thumbnails are deleted when nothing else uses them. Exported copies elsewhere are untouched.
- Documents are read by extraction: PDF text by page (poppler), DOCX paragraphs and tables, XLSX cells (formulas are shown with their cached values; hidden sheets are left out), CSV, JSON, XML and HTML. Macros never run and external links are never fetched. Scanned pages are reported so you can use OCR on them.
- Recordings imported with **More › Transcribe a recording** also keep a timestamped transcript (WebVTT) as a conversation file.

## Images

Set up backends in **Settings › Connections › Images & analysis**:

- **OpenAI** and **Google** image APIs use the API keys in Settings. They are billed cloud services: the first request from the Workbench asks you to acknowledge billing. By default the assistant asks before each image job it wants to start; you can instead let it start jobs up to a daily number of images. Provider-side limits remain the real spending cap.
- **ComfyUI** uses your own server. Import a workflow in API format, then review the inputs Cere found (prompt, seed, size, image and mask inputs) and the nodes it uses. Workflows with cloud nodes are labeled as such. Missing models and nodes are reported by **Test**.

**Create image** works whatever the chat model can do. Choose the backend, size and the other settings it supports. **Check settings** shows what will be adjusted before anything is sent.

**View and edit** opens the image editor: move, crop (with ratios), arrows, boxes, freehand, labels, a mask brush and eraser, zoom, compare with another version, rotate, flip, resize, format conversion, and opening in another app. Every result is a new version; originals are never changed. **Use mask for an edit** sends the mask with the image. **Keep pixels outside the selection unchanged** composites the result so that only the masked area can change.

Long jobs appear in **Runs** with their state. An image job that was sent but whose result is unknown is never sent again automatically. For ComfyUI, Cere asks the server for the job's status after a restart. **Retry** asks you to confirm when the earlier attempt's outcome is unknown.

Low-memory mode (in the same settings) runs one local GPU job at a time and lets chat go first.

## Vision, OCR and the review helper

- The **vision helper** lets a conversation whose model cannot see images ask another model about one image. Its answers are labeled as the helper's.
- **OCR** uses Tesseract on this computer, with the languages you set (for example `eng+deu`).
- The **review helper** is a second model for narrow reviews: summarizing documents, reviewing a pending change set, or summarizing research material. It receives only the inputs chosen for that request, has no tools and changes nothing. Its calls appear in Activity.

Images and files are never sent to a helper whose destination their permissions do not allow.

## Analysis: Code Lab, commands and Git

Turn on Code Lab in **Settings › Connections › Images & analysis**. Runs use Python inside bubblewrap without network access. The conversation's files are mounted as read-only inputs, and only files written to the output folder become conversation files. The Runs tab shows which limits are enforced on this computer: memory, process count (with a systemd user session) and time. Built-in recipes cover summaries, plots, comparisons and reports. **Let Cere run code for 30 minutes** allows up to 10 runs without asking each time.

Commands in a workspace folder (folder permission **Run commands**) always ask, run isolated with that folder writable, and report the files they changed. Git inspection (status, diff, log) is read-only, with hooks and external diff programs disabled.

If isolation cannot be established, for example because `bubblewrap` is not installed, Code Lab and commands are reported as unavailable instead of running unconfined.

## Project shelf and recipes

The **Shelf** tab lists what this project has collected: shared and pinned files, bound collections, the capsule's accepted decisions and tasks, other conversations and saved recipes. Each item keeps its own storage and rules. **Use in next message** adds a reference; nothing on the shelf enters a prompt by itself.

**Project workflows** includes Workbench recipes with typed inputs (a folder, file, conversation file or collection, picked rather than typed):

- **Explain this project**
- **Review configuration change**
- **Folder cleanup plan**
- **Document briefing**
- **Image asset kit**
- **Screenshot to issue report**
- **Data to report**
- **Release materials**

Each one stages real outputs, such as a change set for review, image or chart files, or a cited briefing. A recipe draft gets the folders you referenced with the same permissions, and sends exactly the references you reviewed. Schedules for conversations that use the Workbench also check its folders and their permissions, the image backends and Code Lab. Any change pauses the schedule for a fresh review.

## Connections and tool servers

**Settings › Connections › Saved connections** keeps more Ollama computers and OpenAI-compatible endpoints under names. Choose one in **New conversation**. A conversation stays on the connection it was created on; moving it to another connection asks you to confirm the new destination. The Ollama and compatible-endpoint settings above remain the defaults for new conversations. Keys are saved per endpoint address in the credentials file, never in settings.

**Settings › AI assistance › Tool servers** adds MCP servers as a program (stdio) or an **HTTP address** (Streamable HTTP):

- Internet servers need HTTPS and must resolve to public addresses.
- Mark a server as on this computer or your network to use plain HTTP or a private address.
- An optional `BEARER_TOKEN` secret is sent only to the server's own address, never across a redirect.
- Servers that require an OAuth sign-in are not supported yet.

Ready servers show when their tools were last listed. **Resources…** browses and reads a server's resources; **Keep in this conversation** saves one as a file. **Prompts…** fills in a server's prompt template and puts the text in the message box for you to edit. Images returned by tools become conversation files.

## Backups and phones

**Backup and restore** can include conversation files: their records always, and their contents unless you turn that off. A restore checks every file's hash. Files whose contents are missing or altered come back without their contents, and the review tells you how many. Folder access, pending changes, image and analysis runs, budgets in progress and edit grants are never restored. Tools stay paused after a restore, and a backup made before you forgot something brings back no conversation files.

Phones see Workbench cards as text in Activity. Folders, files, images, runs and Workbench settings stay on the desktop; see [the feature matrix](FEATURE-MATRIX.md).

## Optional packages (Arch)

| Package | Used for | When missing |
| --- | --- | --- |
| `gcc` (build time) | the `cere-workspacefs` helper | Files is unavailable |
| `bubblewrap` | Code Lab, commands, PDF reading in isolation | Code Lab and commands are unavailable; PDFs are read without isolation |
| `ripgrep` | regular-expression search | literal search still works |
| `poppler` | PDF text | PDFs report that poppler is needed |
| `tesseract`, `tesseract-data-eng` (and other languages) | OCR | OCR reports it is not installed |
| `python` (with `numpy`, `matplotlib` for charts) | Code Lab | Code Lab is unavailable |
| `ffmpeg`, whisper.cpp | transcription | transcription is unavailable |

No browser engine is required. Interactive HTML previews need an optional isolated preview module that this build does not include, so HTML files show their source and nothing in them runs.
