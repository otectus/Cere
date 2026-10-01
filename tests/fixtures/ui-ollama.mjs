import { createServer } from 'node:http';
const models=[{name:'fixture-chat:latest',model:'fixture-chat:latest',capabilities:['completion','tools','vision']},{name:'fixture-plain:latest',model:'fixture-plain:latest',capabilities:['completion']},{name:'nomic-embed-text:latest',model:'nomic-embed-text:latest',capabilities:['embedding'],digest:'fixture-embedding-1'}];
const server=createServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk;
  const body=text?JSON.parse(text):{};
  if(req.url==='/test/extraction-models'){
    models.splice(3);
    if(req.method==='POST')for(const name of ['glm-5.3-flash','nemotron-3-super','nemotron-3-ultra'])models.push({name:name+':cloud',model:name+':cloud',capabilities:['completion'],digest:'a'.repeat(64),remote_host:'https://ollama.com'});
    res.end('{}');
  }
  else if(req.url==='/api/tags')res.end(JSON.stringify({models}));
  else if(req.url==='/api/show')res.end(JSON.stringify(models.find(m=>m.model===body.model)||{error:'missing model'}));
  else if(req.url==='/api/embed')res.end(JSON.stringify({embeddings:body.input.map(()=>[1,0,0])}));
  else if(req.url.startsWith('/search?'))res.end(JSON.stringify({results:[{title:'Ollama embeddings',url:'https://docs.ollama.com/api/embed',content:'Generate embeddings with Ollama.'}]}));
  else if(req.url==='/api/chat'){
    res.setHeader('Content-Type','application/x-ndjson');
    res.write(JSON.stringify({message:{role:'assistant',content:'Hello from Ollama. '},done:false})+'\n');
    if(body.messages?.at(-1)?.content==='queue-validation-hold')await new Promise(resolve=>setTimeout(resolve,2500));
    res.end(JSON.stringify({message:{role:'assistant',content:'Your conversation is ready.'},done:true})+'\n');
  }else{res.statusCode=404;res.end('{}');}
});
server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port));
process.on('SIGTERM',()=>{server.closeAllConnections();server.close();});
