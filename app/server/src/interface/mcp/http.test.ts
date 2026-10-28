import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerMcpHttp } from "./http";
import type { Services } from "../http/routes";
import type { Env } from "../../env";

test("idle MCP sessions expire on POST, GET and DELETE without changing the two-hour default",async t=>{
  let now=1_000;
  const app=Fastify();
  registerMcpHttp(app,{} as Services,{root:process.cwd(),boardDir:process.cwd(),host:"127.0.0.1",port:0} as Env,()=>now);
  await app.listen({host:"127.0.0.1",port:0});t.after(()=>app.close());
  const address=app.server.address();assert.ok(address && typeof address !== "string");
  const url=`http://127.0.0.1:${address.port}/mcp`;
  const headers={"content-type":"application/json",accept:"application/json, text/event-stream"};
  for(const method of ["POST","GET","DELETE"]) {
    const init=await fetch(url,{method:"POST",headers,body:JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"idle-test",version:"1"}}})});
    assert.equal(init.status,200);const id=init.headers.get("mcp-session-id")!;assert.ok(id);await init.text();
    const initialized=await fetch(url,{method:"POST",headers:{...headers,"mcp-session-id":id},body:JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})});assert.equal(initialized.status,202);await initialized.text();
    now+=2*60*60*1000+1;
    const expired=await fetch(url,{method,headers:{...(method === "POST" ? headers : {accept:headers.accept}),"mcp-session-id":id},...(method === "POST" ? {body:JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/list"})} : {})});
    assert.equal(expired.status,404);assert.match((await expired.json() as {error:{message:string}}).error.message,/initializ/i);
  }
});
