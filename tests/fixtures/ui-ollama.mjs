import { createServer } from 'node:http';
const models=[{name:'fixture-chat:latest',model:'fixture-chat:latest',capabilities:['completion','tools','vision']},{name:'fixture-plain:latest',model:'fixture-plain:latest',capabilities:['completion']},{name:'nomic-embed-text:latest',model:'nomic-embed-text:latest',capabilities:['embedding'],digest:'fixture-embedding-1'}];
const loaded=new Set();
const server=createServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk;
  const body=text?JSON.parse(text):{};
  if(req.url==='/test/extraction-models'){
    models.splice(3);
    if(req.method==='POST')for(const name of ['glm-5.3-flash','nemotron-3-super','nemotron-3-ultra'])models.push({name:name+':cloud',model:name+':cloud',capabilities:['completion'],digest:'a'.repeat(64),remote_host:'https://ollama.com'});
    res.end('{}');
  }
  else if(req.url==='/api/tags')res.end(JSON.stringify({models}));
  // M13: the OpenAI-compatible routes Ollama also serves.
  else if(req.url==='/v1/models')res.end(JSON.stringify({object:'list',data:models.filter(m=>!m.capabilities.includes('embedding')).map(m=>({id:m.model,object:'model'}))}));
  else if(req.url==='/v1/chat/completions'){
    res.setHeader('Content-Type','text/event-stream');
    const chunk=(delta,finish=null)=>'data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:finish}]})+'\n\n';
    res.write(chunk({role:'assistant',content:'Hello from the compatible endpoint.'}));
    res.end(chunk({},'stop')+(body.stream_options?.include_usage?'data: '+JSON.stringify({choices:[],usage:{prompt_tokens:120,completion_tokens:7}})+'\n\n':'')+'data: [DONE]\n\n');
  }
  // M09: a pull streams progress, then the model is listed; embedding-named models can embed.
  else if(req.url==='/api/pull'){
    res.setHeader('Content-Type','application/x-ndjson');
    const name=body.model.includes(':')?body.model:body.model+':latest';
    // A download that stays in progress until it is cancelled.
    if(body.model==='fixture-slow-pull'){res.write(JSON.stringify({status:'pulling fixture layer',completed:100,total:1000})+'\n');req.on('close',()=>{});return;}
    for(const completed of [0,400,800,1000]){res.write(JSON.stringify({status:'pulling fixture layer',completed,total:1000})+'\n');await new Promise(resolve=>setTimeout(resolve,120));}
    if(!models.some(m=>m.model===name))models.push({name,model:name,size:1000,capabilities:name.includes('embed')?['embedding']:['completion'],digest:'pulled-'+name});
    res.end(JSON.stringify({status:'success'})+'\n');
  }
  else if(req.url==='/api/delete'){const index=models.findIndex(m=>m.model===body.model||m.name===body.model);if(index<0){res.statusCode=404;res.end('{}')}else{models.splice(index,1);loaded.delete(body.model);res.end('{}')}}
  else if(req.url==='/api/ps')res.end(JSON.stringify({models:[...loaded].map(name=>({name,model:name,size_vram:500,expires_at:new Date(Date.now()+600000).toISOString()}))}));
  else if(req.url==='/api/generate'&&body.keep_alive!==undefined){if(body.keep_alive===0)loaded.delete(body.model);else loaded.add(body.model);res.end(JSON.stringify({model:body.model,done:true}))}
  else if(req.url==='/api/show')res.end(JSON.stringify(models.find(m=>m.model===body.model)||{error:'missing model'}));
  else if(req.url==='/api/embed')res.end(JSON.stringify({embeddings:body.input.map(()=>[1,0,0])}));
  else if(req.url.startsWith('/search?'))res.end(JSON.stringify({results:[{title:'Ollama embeddings',url:'https://docs.ollama.com/api/embed',content:'Generate embeddings with Ollama.'}]}));
  else if(req.url==='/api/chat'){
    res.setHeader('Content-Type','application/x-ndjson');
    // The phone's paired connectivity check (ConnectedDesktopTest) asks for this exact reply.
    const users=(body.messages||[]).filter(m=>m.role==='user');
    if(String(users.at(-1)?.content).includes('Reply with exactly CERE_MOBILE_OK'))return res.end(JSON.stringify({message:{role:'assistant',content:'CERE_MOBILE_OK'},done:true})+'\n');
    res.write(JSON.stringify({message:{role:'assistant',content:'Hello from Ollama. '},done:false})+'\n');
    if(body.messages?.at(-1)?.content==='queue-validation-hold')await new Promise(resolve=>setTimeout(resolve,2500));
    res.end(JSON.stringify({message:{role:'assistant',content:'Your conversation is ready.'},done:true})+'\n');
  }else{res.statusCode=404;res.end('{}');}
});
server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port));
process.on('SIGTERM',()=>{server.closeAllConnections();server.close();});
