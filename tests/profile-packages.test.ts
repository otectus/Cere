import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { projectConventions } from '../broker/project-instructions.ts';

const idle = () => ({ async send() {}, async interrupt() {}, async close() {} });
async function broker(t: any, realProviders = false) {
  const dir = await mkdtemp(join(tmpdir(), 'cere-packages-'));
  const core = new Core(new Store(join(dir, 'state')), realProviders ? undefined : idle);
  t.after(async () => { await core.close(); await rm(dir, { recursive: true, force: true }); });
  return { core, dir };
}

test('A06 a package carries styles and recipes only, previews before importing, and updates by stable id', async t => {
  const source = await broker(t), target = await broker(t);
  const style = await source.core.rpc('presets.save', { label: 'Reviewer', text: 'Review carefully.', traits: { directness: 2 }, ceiling: { desktop: false }, constraints: ['no-emoji'], expectedRevision: '0' });
  await source.core.rpc('presets.checkpoint', { id: style.id, expectedItemRevision: '1' });
  const recipe = await source.core.workflows.dispatch('recipes.save', { name: 'Audit docs', description: 'Check docs', inputs: [], instructions: 'Audit the docs.', expectedOutput: 'Findings', permissions: { nativeAccess: ['Read files'], description: 'Reads only.' }, runtime: { maxSeconds: 120, maxTurns: 1 } }) as any;
  await source.core.updateSettings({ bypassCliPermissions: true, categories: ['timers'] });
  const exported = await source.core.rpc('packages.export', { profiles: [style.id], recipes: [recipe.id] });
  const parsed = JSON.parse(exported.text);
  assert.deepEqual(Object.keys(parsed).sort(), ['created', 'format', 'profiles', 'recipes', 'schema']);
  assert.equal(parsed.profiles[0].checkpoints, undefined, 'local history stays local');
  assert.doesNotMatch(exported.text, /bypass|categories|grants|apiKey|credential/i, 'no authority or secrets travel');
  // Preview reports changes and saves nothing; import needs the reviewed preview.
  const preview = await target.core.rpc('packages.preview', { text: exported.text });
  assert.deepEqual([preview.profiles[0].action, preview.recipes[0].action], ['new', 'new']);
  assert.equal(target.core.presets.catalog().items.length, 0);
  await assert.rejects(target.core.rpc('packages.import', { token: preview.token, digest: 'tampered' }), /Preview the package again/);
  // A chosen file previews the same way; folders, oversized files and text plus file are refused.
  const file = join(target.dir, 'package.json');
  await writeFile(file, exported.text);
  await assert.rejects(target.core.rpc('packages.preview', { path: target.dir }), /Choose a package file/);
  await assert.rejects(target.core.rpc('packages.preview', { path: file, text: exported.text }), /not both/);
  await writeFile(join(target.dir, 'huge.json'), 'x'.repeat(1024 * 1024 + 1));
  await assert.rejects(target.core.rpc('packages.preview', { path: join(target.dir, 'huge.json') }), /up to 1 MB/);
  const second = await target.core.rpc('packages.preview', { path: file });
  assert.equal(second.digest, preview.digest);
  await target.core.rpc('packages.import', { token: second.token, digest: second.digest });
  const imported = target.core.presets.catalog().items[0];
  assert.deepEqual([imported.id, imported.label, imported.ceiling, imported.constraints], [style.id, 'Reviewer', { desktop: false }, ['no-emoji']]);
  assert.equal(target.core.settings.bypassCliPermissions, false, 'importing changes no permission');
  assert.deepEqual(target.core.settings.categories, []);
  // The same package again is unchanged; an edited one updates in place and a recipe gains a version.
  const again = await target.core.rpc('packages.preview', { text: exported.text });
  assert.deepEqual([again.profiles[0].action, again.recipes[0].action], ['unchanged', 'unchanged']);
  parsed.profiles[0].text = 'Review very carefully.'; parsed.recipes[0].instructions = 'Audit every doc.';
  const edited = JSON.stringify(parsed), changed = await target.core.rpc('packages.preview', { text: edited });
  assert.deepEqual([changed.profiles[0].action, changed.recipes[0].action], ['changed', 'changed']);
  await target.core.rpc('packages.import', { token: changed.token, digest: changed.digest });
  assert.equal(target.core.presets.catalog().items[0].text, 'Review very carefully.');
  assert.equal(((await target.core.workflows.dispatch('recipes.get', { id: recipe.id })) as any).version, 2);
  // Grants smuggled into a style are refused; unknown fields and newer formats import nothing.
  for (const [mutate, error] of [
    [(value: any) => { value.profiles[0].ceiling = { desktop: true, admin: true }; }, /can only withhold/],
    [(value: any) => { value.grants = []; }, /fields Cere does not import/],
    [(value: any) => { value.schema = 2; }, /newer version of Cere/],
    [(value: any) => { value.recipes[0].id = 'review-diff'; }, /built-in recipe/],
  ] as [(value: any) => void, RegExp][]) {
    const copy = JSON.parse(exported.text); mutate(copy);
    await assert.rejects(target.core.rpc('packages.preview', { text: JSON.stringify(copy) }), error);
  }
});

test('A06 project conventions are opt-in, bounded, read fresh each turn, never through links, and recorded by hash', async t => {
  const requests: any[] = [];
  const server = createServer((req, res) => { let body = ''; req.on('data', c => body += c); req.on('end', () => {
    if (req.url === '/api/show') { res.end(JSON.stringify({ capabilities: ['completion'], model_info: { 'general.architecture': 'x', 'x.context_length': 32768 } })); return; }
    if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ model: 'm', name: 'm', capabilities: ['completion'] }] })); return; }
    requests.push(JSON.parse(body)); res.end(JSON.stringify({ message: { role: 'assistant', content: 'OK.' }, done: true }) + '\n');
  }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const { core, dir } = await broker(t, true);
  await writeFile(join(dir, 'AGENTS.md'), 'Use tabs. Run npm test before committing.');
  await writeFile(join(dir, 'secret.md'), 'linked secret');
  await symlink(join(dir, 'secret.md'), join(dir, 'CLAUDE.md'));
  assert.deepEqual((await projectConventions(dir)).files.map(file => file.name), ['AGENTS.md'], 'a linked convention file is not read');
  await core.updateSettings({ ollama: { host: `http://127.0.0.1:${(server.address() as any).port}` } });
  await core.rpc('projects.save', { cwd: dir, name: 'P', favorite: false, expectedRevision: '0', defaults: { provider: 'ollama', model: 'm', effort: '', tools: false, trusted: true, temporary: false } });
  const session = await core.create({ provider: 'ollama', model: 'm', cwd: dir });
  const turn = async (text: string) => { await core.rpc('session.send', { id: session.id, text }); for (let index = 0; index < 300 && core.store.session(session.id).status !== 'idle'; index++) await new Promise(resolve => setTimeout(resolve, 10)); return JSON.stringify(requests.at(-1).messages); };
  assert.doesNotMatch(await turn('First'), /cere_project_conventions/, 'off until the project opts in');
  await core.rpc('projects.setConventions', { cwd: dir, expectedRevision: '1', enabled: true });
  assert.match(await turn('Second'), /<cere_project_conventions>.*Use tabs/);
  await writeFile(join(dir, 'AGENTS.md'), 'Use spaces now.');
  assert.match(await turn('Third'), /Use spaces now/, 'a changed file shows in the next turn');
  const layer = (await core.rpc('session.context', { id: session.id })).lastPlan.layers.find((item: any) => item.id === 'conventions');
  assert.match(layer.detail.files[0], /^AGENTS\.md [0-9a-f]{12}$/);
});
