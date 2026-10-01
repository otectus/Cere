import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { IndexEngine } from '../broker/indextts-engine.ts';
import { defaultIndexConfig, indexPaths } from '../broker/indextts-config.ts';

const config={...defaultIndexConfig,version:process.env.CERE_INDEXTTS_VERSION==='2'?'2' as const:'2.5' as const,device:process.env.CERE_INDEXTTS_DEVICE||'cpu'};
const installed=await access(join(indexPaths(config).modelDir,'installation.json')).then(()=>true,()=>false);
test('opt-in: installed IndexTTS synthesizes every supported language offline',{
  skip:process.env.CERE_INDEXTTS_INTEGRATION!=='1'||!installed||!process.env.CERE_INDEXTTS_REFERENCE,
  timeout:30*60*1000,
},async t=>{
  const engine=new IndexEngine(config);t.after(()=>engine.unload());const caps=await engine.load();
  assert.equal((await engine.command('offline-test')).networkDenied,true);
  const samples:Record<string,string>={en:'Hello there.',zh:'你好世界。',ja:'こんにちは。',es:'Hola, amigos.',ar:'مرحباً بكم.'};
  for(const language of caps.languages){
    let samplesCount=0,expected=0;
    for await(const chunk of engine.synthesize({generationId:language,chunks:[samples[language]],language,reference:process.env.CERE_INDEXTTS_REFERENCE,emotion:{source:'same-as-speaker'},durationFactor:1})){
      assert.equal(chunk.sampleRate,caps.sampleRate);assert.equal(chunk.seq,expected++);samplesCount+=chunk.pcm.length/2;
    }
    const duration=samplesCount/caps.sampleRate;assert.ok(duration>.1&&duration<120,`${language} duration out of bounds`);
  }
});
