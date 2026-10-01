#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

let bytes = 0;
for await (const chunk of process.stdin) bytes += chunk.length;
if (process.env.CERE_AUDIO_SINK_LOG) appendFileSync(process.env.CERE_AUDIO_SINK_LOG, JSON.stringify({ bytes }) + '\n');
if (!bytes) process.exitCode = 1;
