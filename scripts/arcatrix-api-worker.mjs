const EXECUTOR="https://bznurgvcucnomxkyolcn.functions.supabase.co/arcatrix_executor";
const OIDC=process.env.ARCATRIX_OIDC_TOKEN||"";
const GH=process.env.GITHUB_TOKEN||"";
const CURRENT_REPO=process.env.GITHUB_REPOSITORY||"";
if(!CURRENT_REPO)throw new Error("GITHUB_REPOSITORY missing");
if(!OIDC)throw new Error("ARCATRIX_OIDC_TOKEN missing");

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function message(e){return e instanceof Error?e.message:String(e)}
function retryable(e){
 const parts=[];let cur=e;
 for(let i=0;i<4&&cur;i++){parts.push(message(cur));cur=cur?.cause}
 return /429|5\d\d|timeout|timed out|fetch failed|econnreset|econnrefused|enotfound|eai_again|socket hang up/i.test(parts.join(" "));
}
function safePath(path){
 const parts=String(path||"").split("/").filter(Boolean);
 if(parts.some(p=>p==="."||p===".."))throw new Error("invalid_repository_path");
 return parts.map(encodeURIComponent).join("/");
}
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
const decodeGitHubContent=v=>Buffer.from(String(v||"").replace(/\n/g,""),"base64").toString("utf8");

async function redispatch(owner,name){
 try{
  await gh("POST",`/repos/${owner}/${name}/actions/workflows/arcatrix-api-worker.yml/dispatches`,{ref:"main"});
  return{ok:true,error:null};
 }catch(e){
  return{ok:false,error:message(e)};
 }
}

async function runGitHub(a){
 const i=a.instruction||{},repo=String(i.repository||""),[owner,name]=repo.split("/");
 if(!owner||!name)throw new Error("repository_required");
 if(repo!==CURRENT_REPO)throw new Error("repository_scope_mismatch");
 const op=String(a.operation||"");

 if(op==="read_repository"){
   const path=String(i.path||""),encoded=safePath(path),ref=String(i.ref||"main");
   const endpoint=encoded?`/repos/${owner}/${name}/contents/${encoded}`:`/repos/${owner}/${name}/contents`;
   const data=await gh("GET",`${endpoint}?ref=${encodeURIComponent(ref)}`);
   const dir=Array.isArray(data);
   const textFile=!dir&&data?.type==="file"&&data?.encoding==="base64"&&Number(data?.size??0)<=32768&&(/\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml|toml|sql|css|html|txt|py|sh)$/i.test(path)||/(^|\/)(?:Dockerfile|Makefile|Procfile)$/i.test(path));
   const items=dir?data.slice(0,200).map(x=>({name:x?.name??null,path:x?.path??null,type:x?.type??null,sha:x?.sha??null,size:x?.size??null})):null;
   const content=textFile?decodeGitHubContent(data.content).slice(0,32768):null;
   return{before_state:{},after_state:{},evidence:{operation:op,repository:repo,ref,path,type:dir?"dir":data?.type??null,sha:dir?null:data?.sha??null,item_count:dir?data.length:null,items,content,content_truncated:textFile&&decodeGitHubContent(data.content).length>32768},external_refs:{provider:"github",repository:repo,sha:dir?null:data?.sha??null,path},spend_cents:0,currency:"USD"};
 }

 if(op==="create_branch"){
   const base=String(i.base||"main"),branch=String(i.branch||"");if(!branch)throw new Error("branch_required");
   try{
     const existing=await gh("GET",`/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(branch)}`);
     return{before_state:{branch,already_exists:true},after_state:{branch,sha:existing.object?.sha??null,already_applied:true},evidence:{operation:op,repository:repo,resumed:true},external_refs:{provider:"github",repository:repo,branch},spend_cents:0,currency:"USD"};
   }catch(e){if(!message(e).includes("github_http_404"))throw e}
   const baseRef=await gh("GET",`/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(base)}`);
   const out=await gh("POST",`/repos/${owner}/${name}/git/refs`,{ref:`refs/heads/${branch}`,sha:baseRef.object.sha});
   return{before_state:{base,sha:baseRef.object.sha},after_state:{branch,sha:out.object?.sha??baseRef.object.sha},evidence:{operation:op,repository:repo},external_refs:{provider:"github",repository:repo,branch},spend_cents:0,currency:"USD"};
 }

 if(op==="write_code"){
   const path=String(i.path||""),encoded=safePath(path),branch=String(i.branch||""),content=String(i.content??""),commitMessage=String(i.message||"Arcatrix governed update");
   if(!path||!branch)throw new Error("path_and_branch_required");
   let current=null;
   try{current=await gh("GET",`/repos/${owner}/${name}/contents/${encoded}?ref=${encodeURIComponent(branch)}`)}catch(e){if(!message(e).includes("github_http_404"))throw e}
   if(current?.encoding==="base64"&&decodeGitHubContent(current.content)===content){
     return{before_state:{path,sha:current.sha},after_state:{path,sha:current.sha,already_applied:true},evidence:{operation:op,repository:repo,branch,resumed:true},external_refs:{provider:"github",repository:repo,path,blob_sha:current.sha},spend_cents:0,currency:"USD"};
   }
   const out=await gh("PUT",`/repos/${owner}/${name}/contents/${encoded}`,{message:commitMessage,content:b64(content),branch,...(current?.sha?{sha:current.sha}:{})});
   return{before_state:{path,sha:current?.sha??null},after_state:{path,sha:out.content?.sha??null,commit_sha:out.commit?.sha??null},evidence:{operation:op,repository:repo,branch},external_refs:{provider:"github",repository:repo,path,commit_sha:out.commit?.sha??null},spend_cents:0,currency:"USD"};
 }

 if(op==="open_pull_request"){
   const title=String(i.title||"Arcatrix governed change"),head=String(i.head||""),base=String(i.base||"main"),body=String(i.body||"");
   if(!head)throw new Error("head_required");
   const marker="<!-- arcatrix-action:"+a.id+" -->";
   const existing=await gh("GET","/repos/"+owner+"/"+name+"/pulls?state=all&head="+encodeURIComponent(owner+":"+head)+"&base="+encodeURIComponent(base)+"&per_page=100");
   const prior=Array.isArray(existing)?existing.find(p=>String(p?.body||"").includes(marker)):null;
   if(prior){
     if(prior.state==="open"||prior.merged_at)return{before_state:{},after_state:{number:prior.number,state:prior.state,url:prior.html_url,already_applied:true},evidence:{operation:op,repository:repo,resumed:true,action_marker:marker},external_refs:{provider:"github",repository:repo,pull_request_number:prior.number,url:prior.html_url},spend_cents:0,currency:"USD"};
     throw new Error("github_action_pr_closed_unmerged");
   }
   const bodyWithMarker=body?body+"\n\n"+marker:marker;
   const out=await gh("POST","/repos/"+owner+"/"+name+"/pulls",{title,head,base,body:bodyWithMarker});
   return{before_state:{},after_state:{number:out.number,state:out.state,url:out.html_url},evidence:{operation:op,repository:repo,action_marker:marker},external_refs:{provider:"github",repository:repo,pull_request_number:out.number,url:out.html_url},spend_cents:0,currency:"USD"};
 }

 if(op==="merge_pull_request"){
   const number=Number(i.pull_request_number);if(!Number.isInteger(number)||number<1)throw new Error("pull_request_number_required");
   const current=await gh("GET",`/repos/${owner}/${name}/pulls/${number}`);
   let sha=current.merge_commit_sha??null,resumed=false;
   if(!current.merged_at){
     const out=await gh("PUT",`/repos/${owner}/${name}/pulls/${number}/merge`,{merge_method:String(i.merge_method||"squash"),commit_title:i.commit_title||undefined});
     if(!out.merged)throw new Error("github_merge_not_completed");
     sha=out.sha??sha;
   }else resumed=true;
   const dispatch=await redispatch(owner,name);
   return{before_state:{pull_request_number:number,already_merged:resumed},after_state:{merged:true,sha,worker_redispatched:dispatch.ok,redispatch_error:dispatch.error},evidence:{operation:op,repository:repo,resumed,redispatch_best_effort:true,worker_redispatched:dispatch.ok,redispatch_error:dispatch.error},external_refs:{provider:"github",repository:repo,pull_request_number:number,sha},spend_cents:0,currency:"USD"};
 }

 throw new Error("unsupported_github_operation:"+op);
}

async function receipt(a,status,result,error){
 if(!a.lease_token)throw new Error("lease_token_missing");
 const payload={action_id:a.id,lease_token:a.lease_token,status,before_state:result?.before_state||{},after_state:result?.after_state||{},evidence:result?.evidence||{error,retryable:retryable(error)},external_refs:result?.external_refs||{provider:a.capability_id},spend_cents:result?.spend_cents||0,currency:result?.currency||"USD"};
 let last;
 for(const delay of [0,1000,3000]){
  if(delay)await sleep(delay);
  try{return await post("receipt",payload)}catch(e){last=e}
 }
 throw last??new Error("receipt_delivery_failed");
}

async function executeAction(a){
 let result;
 try{
   if(a.capability_id==="github")result=await runGitHub(a);
   else throw new Error("connector_not_configured:"+a.capability_id);
 }catch(e){
   const m=message(e);
   await receipt(a,"failed",null,m).catch(reportError=>console.error("failed_receipt_delivery_failed",message(reportError)));
   throw e;
 }
 try{
   await receipt(a,"completed",result);
 }catch(e){
   console.error("completed_receipt_delivery_failed",message(e));
   throw e;
 }
 console.log(JSON.stringify({ok:true,action_id:a.id,status:"completed",capability_id:a.capability_id,operation:a.operation}));
}

async function claimOne(actionClass){
 const claim=await post("claim",{worker_kind:"api",repository:CURRENT_REPO,...(actionClass?{action_class:actionClass}:{})});
 return Array.isArray(claim.action)?claim.action[0]??null:claim.action;
}

async function main(){
 let reads=0;
 for(;reads<8;reads++){
   const a=await claimOne("read");
   if(!a)break;
   if(a.action_class!=="read")throw new Error("filtered_claim_returned_non_read");
   await executeAction(a);
 }
 if(reads>0){
   console.log(JSON.stringify({ok:true,read_actions_completed:reads,mutation_action_completed:false}));
   return;
 }
 const a=await claimOne(null);
 if(!a){console.log("no_api_action");return}
 await executeAction(a);
}
main().catch(e=>{console.error(e);process.exit(1)});
