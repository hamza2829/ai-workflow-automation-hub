import http from 'node:http';
// Stateful external-style test doubles, keyed independently for each API.
const records=new Map();let fail=0;
http.createServer(async(req,res)=>{
 const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
 if(req.url==='/health')return send(200,{status:'ok'});
 if(req.url==='/records')return send(200,[...records.values()]);
 let body='';for await(const part of req)body+=part;
 if(req.url==='/control'){fail=JSON.parse(body).failNext;return send(200,{fail});}
 if(!['/tasks','/invoices','/slack'].includes(req.url))return send(404,{});
 const key=req.url+':'+req.headers['idempotency-key'];
 if(!req.headers['idempotency-key'])return send(400,{error:'Missing idempotency key'});
 if(records.has(key))return send(200,records.get(key));
 if(fail>0){fail--;return send(503,{error:'Injected integration outage'});}
 const result={id:'mock-'+(records.size+1),path:req.url,body:JSON.parse(body)};records.set(key,result);
 console.log(JSON.stringify({event:'mock_delivery',path:req.url,id:result.id}));send(201,result);
}).listen(8090,'0.0.0.0');
