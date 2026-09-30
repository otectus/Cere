import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { helloSchema, requestSchema, methods, mutations, needsProof } from '../broker/remote/schemas.ts';

const requests=Object.entries(methods).map(([method,params])=>{
  const schema:any=z.toJSONSchema(requestSchema.extend({method:z.literal(method),params,...(mutations.has(method)?{commandId:z.uuid()}:{} )}));
  if(needsProof(method,{}))schema.required=[...new Set([...schema.required,'proof'])];
  // Deny and Cancel retain a reserved authenticated connection path without biometrics.
  if(method==='approvals.answer')schema.required=schema.required.filter((key:string)=>key!=='proof');
  if(method==='memory.save')schema.properties.params.dependentRequired={id:['expectedRevision']};
  return schema;
});
const schema={$schema:'https://json-schema.org/draft/2020-12/schema',$id:'https://cere.local/protocol/mobile/v1/client.schema.json',title:'Cere mobile v1 client frames',oneOf:[z.toJSONSchema(helloSchema),z.toJSONSchema(z.strictObject({v:z.literal(1),type:z.literal('auth'),challengeId:z.uuid(),signature:z.string().max(100)})),...requests]};
const output=JSON.stringify(schema,null,2)+'\n',path=new URL('../protocol/mobile/v1/client.schema.json',import.meta.url);
if(process.argv.includes('--check')) {if(readFileSync(path,'utf8')!==output)throw new Error('Mobile JSON Schema is stale. Run node tools/mobile-contract.ts.');}
else writeFileSync(path,output);
