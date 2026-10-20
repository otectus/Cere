#!/usr/bin/env node
// Summarizes JUnit XML reports (node:test, CTest, QtTest, Gradle) as Markdown for a CI step summary:
// totals, every failure, and every skip with its stated reason. Skips are listed rather than hidden,
// so a check that silently stopped running is visible. The exit status is always 0; the test step
// itself decides pass or fail.
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const decode = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const attribute = (tag, name) => { const match = tag.match(new RegExp(`\\s${name}="([^"]*)"`)); return match ? decode(match[1]) : ''; };
const files = process.argv.slice(2).flatMap(path => !existsSync(path) ? [] : statSync(path).isDirectory() ? readdirSync(path, { recursive: true }).map(name => join(path, String(name))).filter(name => name.endsWith('.xml')) : [path]);
const rows = [];
for (const file of files) {
  const xml = readFileSync(file, 'utf8');
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const tag = match[1], body = match[3] || '', name = attribute(tag, 'name'), suite = attribute(tag, 'classname');
    const failure = body.match(/<(failure|error)\b([^>]*)>/), skipped = body.match(/<skipped\b([^>]*)\/?>(?:([\s\S]*?)<\/skipped>)?/);
    // CTest marks tests it did not run with status="notrun" or "disabled" instead of a child element.
    const status = attribute(tag, 'status');
    const outcome = failure || status === 'fail' ? 'failed' : skipped || status === 'notrun' || status === 'disabled' ? 'skipped' : 'passed';
    const reason = failure ? attribute(failure[2], 'message') || attribute(failure[2], 'type') : skipped ? attribute(skipped[1], 'message') || decode(skipped[2] || '').trim() : status === 'notrun' || status === 'disabled' ? status : '';
    rows.push({ file: basename(file), suite, name, outcome, reason: reason.replace(/\s+/g, ' ').slice(0, 300) });
  }
}
const count = outcome => rows.filter(row => row.outcome === outcome).length;
const cell = text => text.replace(/\|/g, '\\|');
const lines = [`### Test report`, '', `${rows.length} tests from ${files.length} report file${files.length === 1 ? '' : 's'}: ${count('passed')} passed, ${count('failed')} failed, ${count('skipped')} skipped.`, ''];
for (const [outcome, heading] of [['failed', 'Failures'], ['skipped', 'Skipped, with reasons']]) {
  const selected = rows.filter(row => row.outcome === outcome);
  if (!selected.length) continue;
  lines.push(`#### ${heading}`, '', '| Report | Test | Reason |', '| --- | --- | --- |');
  for (const row of selected) lines.push(`| ${cell(row.file)} | ${cell([row.suite, row.name].filter(Boolean).join(' › '))} | ${cell(row.reason || 'no reason given')} |`);
  lines.push('');
}
if (!files.length) lines.push('No report files were produced; the step that writes them did not run or failed before writing.');
console.log(lines.join('\n'));
