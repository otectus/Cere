#!/usr/bin/env node
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
if(process.env.CERE_AGY_TEST_LOG)appendFileSync(process.env.CERE_AGY_TEST_LOG,JSON.stringify(process.argv.slice(2))+'\n');
if(process.argv.includes('--help')) {console.error('--input-format --output-format --conversation --disable-slash-commands');process.exit(0);}
if(process.argv.includes('models')) {console.log('fixture-model\tFixture Model');process.exit(0);}
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
for await(const line of readline.createInterface({input:process.stdin})) {
  const prompt=JSON.parse(line).message.content;
  send({event:'init',conversation_id:'fixture-conversation'});
  send({event:'step_update',step_update:{step_index:0,step_type:'user_input',state:'DONE'}});
  if(prompt.endsWith('hang')) {await new Promise(()=>{});}
  if(prompt.endsWith('fail')) {send({event:'result',result:{status:'ERROR',error:'provider failure'}});continue;}
  if(prompt.endsWith('fail-details')) {send({event:'result',result:{status:'ERROR',error:{message:'\u001b[31mmodel conflicts with effort\u001b[0m; Bearer test-secret; api_key=test-key'}}});continue;}
  if(prompt.endsWith('fail-empty')) {send({event:'result',result:{status:'ERROR'}});continue;}
  send({event:'step_update',step_update:{step_index:1,step_type:'agent_response',state:'ACTIVE',text_delta:'Hello '}});
  send({event:'step_update',step_update:{step_index:1,step_type:'agent_response',state:'DONE',text_delta:'there'}});
  send({event:'step_update',step_update:{step_index:2,step_type:'tool',state:'DONE',tool_name:'read_file',tool_info:{output:'done'}}});
  send({event:'step_update',step_update:{step_index:3,step_type:'agent_response',state:'DONE',text_delta:'Finished'}});
  send({event:'result',result:{conversation_id:'fixture-conversation',status:'SUCCESS',response:'Finished'}});
}
