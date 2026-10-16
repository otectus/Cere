// Seeds the isolated demo profile used by the documentation screenshots: folders, projects, past
// conversations across providers, saved scripts and a completion record. Run before the broker starts:
//   CERE_STATE_DIR=... node tools/screenshots/seed.ts <demo home>
import { randomUUID } from 'node:crypto';
import { Store } from '../../broker/store.ts';
import type { Message, Session, SessionFolder } from '../../broker/types.ts';

const home = process.argv[2];
if (!home) throw new Error('Usage: seed.ts <demo home>');
const projects = `${home}/Projects`, ollamaHost = 'http://127.0.0.1:11434';
const store = new Store();
const now = Date.now(), minutes = (n: number) => now - n * 60_000, hours = (n: number) => minutes(n * 60), days = (n: number) => hours(n * 24);

const folder = (name: string, created: number): SessionFolder => ({ id: randomUUID(), name, revision: '1', created, updated: created });
const work = folder('Client work', days(20)), lab = folder('Home lab', days(14)), learning = folder('Learning', days(9));
for (const f of [work, lab, learning]) store.saveFolder(f);

type Turn = [role: 'user' | 'assistant' | 'tool', text: string, extra?: Partial<Message>];
function conversation(fields: Partial<Session> & Pick<Session, 'provider' | 'title' | 'cwd' | 'model'>, at: number, turns: Turn[]) {
  const session: Session = { id: randomUUID(), nativeId: fields.provider === 'ollama' || ['openai', 'anthropic', 'google'].includes(fields.provider) ? null : randomUUID(),
    mode: 'managed', status: 'idle', created: at - turns.length * 90_000, updated: at, draft: '', scroll: 0, effort: '', readAt: at, ...fields } as Session;
  store.saveSession(session);
  turns.forEach(([role, text, extra], index) => store.message({ id: randomUUID(), sessionId: session.id, role, text, time: at - (turns.length - index) * 40_000, ...extra }));
  return session;
}

const releasePlan = `## 2.4 in two weeks

Two weeks is plenty, provided SSO stops pretending it's small. Here's the order I'd ship in:

| Item | Effort | Risk | Owner |
| --- | --- | --- | --- |
| Offline drafts | 3 days | Low | You |
| Settings page | 4 days | Medium | Priya |
| SSO (SAML + OIDC) | 6 days | **High** | Marcus |

### Week one
- [x] Freeze the draft storage schema
- [ ] Land offline drafts behind \`drafts.offline\`
- [ ] Port the last four settings panels

### Week two
- [ ] SSO against the staging identity provider
- [ ] Release candidate on **Thursday**, not Friday

\`\`\`bash
git switch -c release/2.4
pnpm changeset version && pnpm test
\`\`\`

> If SSO slips, ship 2.4 without it and follow with 2.4.1. Nobody has ever been sad that a release went out on time.`;

const plan = conversation({ provider: 'claude', title: 'Plan the 2.4 release', cwd: `${projects}/aurora-web`, model: 'default', effort: 'high', folderId: work.id }, minutes(38), [
  ['user', 'Help me plan the 2.4 release. We have two weeks and three big items: offline drafts, the new settings page and SSO.'],
  ['tool', 'Read docs/roadmap.md\n\n# Roadmap\n- 2.4: offline drafts, settings page, SSO\n- 2.5: plugin API'],
  ['tool', 'git log --oneline release/2.3..main | wc -l\n\n147'],
  ['assistant', releasePlan],
  ['user', 'Agreed. If SSO isn\'t merged by Wednesday, it moves to 2.4.1.'],
  ['assistant', 'Decision recorded: SSO moves to 2.4.1 unless it merges by Wednesday. Thursday\'s release candidate ships either way.'],
]);
conversation({ provider: 'ollama', title: 'Hyprland window rules', cwd: `${projects}/dotfiles`, model: 'gpt-oss:20b', ollama: { host: ollamaHost, tools: false }, folderId: lab.id, unread: true, readAt: hours(3) }, hours(2), [
  ['user', 'How do I make Spotify always open on workspace 9?'],
  ['assistant', 'Give Spotify a window rule keyed on its class, and Hyprland will put it on workspace 9 every time it opens:\n\n```ini\nwindowrule = workspace 9 silent, class:^(Spotify)$\n```\n\n`silent` keeps you where you are instead of following it. Reload with `hyprctl reload`, then reopen Spotify to check.',
    { sources: [{ title: 'Window Rules – Hyprland Wiki', url: 'https://wiki.hypr.land/Configuring/Window-Rules/' }, { title: 'Dispatchers – Hyprland Wiki', url: 'https://wiki.hypr.land/Configuring/Dispatchers/' }] }],
]);
conversation({ provider: 'claude', title: 'Rust error handling cleanup', cwd: `${projects}/lumen`, model: 'opus', effort: 'medium' }, hours(26), [
  ['user', 'Replace the unwraps in the config loader with proper errors.'],
  ['tool', 'cargo clippy -- -D clippy::unwrap_used\n\nerror: used `unwrap()` on a `Result` value (14 occurrences)'],
  ['assistant', 'All fourteen `unwrap()` calls are gone. `ConfigError` now uses `thiserror`, and every failure names the file and key involved:\n\n```rust\n#[derive(Debug, thiserror::Error)]\npub enum ConfigError {\n    #[error("cannot read {path}: {source}")]\n    Read { path: PathBuf, source: io::Error },\n    #[error("{key} in {path} is not valid: {reason}")]\n    Invalid { path: PathBuf, key: String, reason: String },\n}\n```\n\n`cargo clippy -- -D clippy::unwrap_used` is clean and all 86 tests pass.'],
]);
conversation({ provider: 'codex', title: 'Backfill March sensor data', cwd: `${projects}/tidepool`, model: 'gpt-6.1-sol', effort: 'high', folderId: work.id }, days(3), [
  ['user', 'Backfill the missing March readings from the raw archive, then rerun the daily rollups.'],
  ['tool', 'python -m tidepool.backfill --from 2026-03-01 --to 2026-03-31\n\nRecovered 41,882 readings from 12 archives'],
  ['assistant', 'Backfilled **41,882** readings for March and rebuilt 31 daily rollups. Two sensors (`TP-07`, `TP-19`) still have gaps on March 14: their raw archives are truncated, so I logged them in `reports/gaps-2026-03.md` rather than inventing values.'],
]);
conversation({ provider: 'ollama', title: 'Explain lifetimes like I\'m tired', cwd: home, model: 'gemma4:31b-cloud', ollama: { host: ollamaHost, tools: false }, folderId: learning.id }, days(4), [
  ['user', 'Explain Rust lifetimes like I\'m tired.'],
  ['assistant', 'A lifetime is a promise: "this reference won\'t outlive the thing it points at." The compiler checks the promise so you don\'t have to remember it at 2 a.m.\n\n`fn longest<\'a>(x: &\'a str, y: &\'a str) -> &\'a str` just says the answer lives as long as the shorter of the two inputs. That\'s it. Go to sleep.'],
]);
conversation({ provider: 'anthropic', title: 'Ramen night shopping list', cwd: home, model: 'claude-sonnet-5', api: { tools: false } }, days(6), [
  ['user', 'Ramen for six on Saturday. What do I need?'],
  ['assistant', '**Broth:** 2 kg pork bones, chicken wings, kombu, dried shiitake\n**Tare:** soy sauce, mirin, sake\n**Toppings:** 6 eggs (marinate Friday), chashu pork belly, scallions, nori, bamboo shoots\n**Noodles:** 6 portions of fresh ramen noodles\n\nStart the broth Saturday morning. It needs the whole day, and so will you.'],
]);
const tests = conversation({ provider: 'codex', title: 'Upgrade to Vite 8', cwd: `${projects}/aurora-web`, model: 'gpt-6.1-sol', effort: 'medium', folderId: work.id }, hours(27), [
  ['user', 'Upgrade the app to Vite 8 and fix whatever breaks.'],
  ['tool', 'pnpm up vite@8 @vitejs/plugin-react@6\n\nProgress: resolved 812, reused 790, downloaded 22, added 22, done'],
  ['tool', 'pnpm build\n\n✓ 1,204 modules transformed.\ndist/assets/index-4f2a9c.js  412.66 kB │ gzip: 131.20 kB'],
  ['assistant', 'Vite 8 is in. Two things needed changes: `import.meta.glob` now defaults to lazy imports, so the route loader opts back in with `eager: true`, and the old `optimizeDeps.esbuildOptions` block moved to `optimizeDeps.rolldownOptions`. The build is 6% smaller and `pnpm test` passes.'],
]);

// The result hub's completion record for the Vite upgrade.
const reply = store.messages(tests.id).at(-1)!;
store.set('completionInbox', [{ id: randomUUID(), sessionId: tests.id, title: tests.title, provider: tests.provider, cwd: tests.cwd, time: reply.time, messageId: reply.id }]);

for (const [cwd, name, favorite, defaults] of [
  [`${projects}/aurora-web`, 'Aurora web app', true, { provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium', tools: false, trusted: true, temporary: false }],
  [`${projects}/lumen`, 'Lumen CLI', false, { provider: 'claude', model: 'opus', effort: 'high', tools: false, trusted: true, temporary: false }],
  [`${projects}/tidepool`, 'Tidepool pipeline', false, { provider: 'codex', model: 'gpt-6-astra', effort: 'high', tools: false, trusted: true, temporary: false }],
  [`${projects}/dotfiles`, 'dotfiles', false, { provider: 'ollama', model: 'gpt-oss:20b', effort: '', tools: true, trusted: true, temporary: false }],
] as const) store.db.prepare('INSERT INTO projects VALUES (?,?)').run(cwd, JSON.stringify({ cwd, name, revision: '1', updated: days(2), favorite, defaults }));

store.set('settings', { ...store.settings(), onboarding: false, topmost: false, roaming: false, quiet: false,
  position: { output: 'Primary', x: 0.9, y: 0.92 }, categories: ['apps', 'windows', 'audio', 'media', 'timers'],
  scripts: [
    { id: randomUUID(), name: 'Run the test suite', executable: `${home}/.local/bin/demo-check`, args: ['test'], cwd: `${projects}/aurora-web`, timeout: 300000 },
    { id: randomUUID(), name: 'Back up notes', executable: `${home}/.local/bin/demo-check`, args: ['backup', '--quiet'], cwd: home, timeout: 60000 },
  ] });
store.set('navigation', { favorites: ['page:settings', 'session:' + plan.id], recents: [] });
store.close();
console.log(plan.id);
