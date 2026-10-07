const EXECUTOR="https://bznurgvcucnomxkyolcn.functions.supabase.co/arcatrix_executor";
const OIDC=process.env.ARCATRIX_OIDC_TOKEN||"";
const GH=process.env.GITHUB_TOKEN||"";
const CURRENT_REPO=process.env.GITHUB_REPOSITORY||"";
if(!CURRENT_REPO)throw new Error("GITHUB_REPOSITORY missing");
if(!OIDC)throw new Error("ARCATRIX_OIDC_TOKEN missing");

async function post(route,body={}){
 const r=await fetch(`${EXECUTOR}/${route}`,{method:"POST",headers:{"content-type":"application/json","authorization":`Bearer ${OIDC}`},body:JSON.stringify(body)});
 const data=await r.json().catch(()=>({}));
 if(!r.ok)throw new Error(`${route}_failed:${r.status}:${JSON.stringify(data).slice(0,240)}`);
 return data;
}
async function gh(method,path,body){
 if(!GH)throw new Error("github_token_missing");
 const r=await fetch("https://api.github.com"+path,{method,headers:{"accept":"application/vnd.github+json","authorization":`Bearer ${GH}`,"x-github-api-version":"2022-11-28","user-agent":"arcatrix-api-worker"},body:body===undefined?undefined:JSON.stringify(body)});
 const text=await r.text();let data={};try{data=text?JSON.parse(text):{}}catch{data={raw:text}};
 if(!r.ok)throw new Error(`github_http_${r.status}:${String(data?.message||"unknown")}`);
 return data;
}
const b64=s=>Buffer.from(s,"utf8").toString("base64");
async function runGitHub(a){
 const i=a.instruction||{},repo=String(i.repository||""),[owner,name]=repo.split("/");
 if(!owner||!name)throw new Error("repository_required");
 if(repo!==CURRENT_REPO)throw new Error("repository_scope_mismatch");
 const op=String(a.operation||"");
 if(op==="read_repository"){
   const path=String(i.path||"");const ref=String(i.ref||"main");
   const data=await gh("GET",`/repos/${owner}/${name}/contents/${path}?ref=${encodeURIComponent(ref)}`);
   return{before_state:{},after_state:{},evidence:{operation:op,repository:repo,ref,path,sha:data?.sha??null,type:data?.type??null},external_refs:{provider:"github",repository:repo,sha:data?.sha??null},spend_cents:0,currency:"USD"};
 }
 if(op==="create_branch"){
   const base=String(i.base||"main"),branch=String(i.branch||"");if(!branch)throw new Error("branch_required");
   const baseRef=await gh("GET",`/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(base)}`);
   const out=await gh("POST",`/repos/${owner}/${name}/git/refs`,{ref:`refs/heads/${branch}`,sha:baseRef.object.sha});
   return{before_state:{base,sha:baseRef.object.sha},after_state:{branch,sha:out.object?.sha??baseRef.object.sha},evidence:{operation:op,repository:repo},external_refs:{provider:"github",repository:repo,branch},spend_cents:0,currency:"USD"};
 }
 if(op==="write_code"){
   const path=String(i.path||""),branch=String(i.branch||""),content=String(i.content??""),message=String(i.message||"Arcatrix governed update");
   if(!path||!branch)throw new Error("path_and_branch_required");
   let sha;try{const cur=await gh("GET",`/repos/${owner}/${name}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`);sha=cur.sha}catch(e){if(!String(e).includes("github_http_404"))throw e}
   const out=await gh("PUT",`/repos/${owner}/${name}/contents/${encodeURIComponent(path)}`,{message,content:b64(content),branch,...(sha?{sha}:{})});
   return{before_state:{path,sha:sha??null},after_state:{path,sha:out.content?.sha??null,commit_sha:out.commit?.sha??null},evidence:{operation:op,repository:repo,branch},external_refs:{provider:"github",repository:repo,path,commit_sha:out.commit?.sha??null},spend_cents:0,currency:"USD"};
 }
 if(op==="open_pull_request"){
   const title=String(i.title||"Arcatrix governed change"),head=String(i.head||""),base=String(i.base||"main"),body=String(i.body||"");
   if(!head)throw new Error("head_required");
   const out=await gh("POST",`/repos/${owner}/${name}/pulls`,{title,head,base,body});
   return{before_state:{},after_state:{number:out.number,state:out.state,url:out.html_url},evidence:{operation:op,repository:repo},external_refs:{provider:"github",repository:repo,pull_request_number:out.number,url:out.html_url},spend_cents:0,currency:"USD"};
 }
 if(op==="merge_pull_request"){
   const number=Number(i.pull_request_number);if(!Number.isInteger(number)||number<1)throw new Error("pull_request_number_required");
   const out=await gh("PUT",`/repos/${owner}/${name}/pulls/${number}/merge`,{merge_method:String(i.merge_method||"squash"),commit_title:i.commit_title||undefined});
   if(!out.merged)throw new Error("github_merge_not_completed");
   let worker_redispatched=false;
   await gh("POST",`/repos/${owner}/${name}/actions/workflows/arcatrix-api-worker.yml/dispatches`,{ref:"main"});
   worker_redispatched=true;
   return{before_state:{pull_request_number:number},after_state:{merged:true,sha:out.sha,worker_redispatched},evidence:{operation:op,repository:repo,worker_redispatched},external_refs:{provider:"github",repository:repo,pull_request_number:number,sha:out.sha},spend_cents:0,currency:"USD"};
 }
 throw new Error("unsupported_github_operation:"+op);
}
async function receipt(a,status,result,error){
 const payload={action_id:a.id,status,before_state:result?.before_state||{},after_state:result?.after_state||{},evidence:result?.evidence||{error,retryable:/429|5\d\d|timeout/i.test(error||"")},external_refs:result?.external_refs||{provider:a.capability_id},spend_cents:result?.spend_cents||0,currency:result?.currency||"USD"};
 return post("receipt",payload);
}
async function main(){
 const claim=await post("claim",{worker_kind:"api",repository:CURRENT_REPO});
 const a=Array.isArray(claim.action)?claim.action[0]??null:claim.action;
 if(!a){console.log("no_api_action");return}
 try{
   let result;
   if(a.capability_id==="github")result=await runGitHub(a);
   else throw new Error("connector_not_configured:"+a.capability_id);
   await receipt(a,"completed",result);
   console.log(JSON.stringify({ok:true,action_id:a.id,status:"completed",capability_id:a.capability_id,operation:a.operation}));
 }catch(e){
   const m=e instanceof Error?e.message:String(e);await receipt(a,"failed",null,m).catch(()=>{});
   throw e;
 }
}
main().catch(e=>{console.error(e);process.exit(1)});