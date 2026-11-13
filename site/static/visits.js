'use strict';
// Optional demo reporting. Production deployments return enabled:false.
(async()=>{
 const params=new URLSearchParams(location.search);
 try{if(params.get('visit')==='off')localStorage.setItem('arc-visit-exclude','1');if(localStorage.getItem('arc-visit-exclude')==='1')return}catch{}
 let config;try{config=await (await fetch('/api/visit-config')).json()}catch{return}
 if(!config.enabled)return;
 let current;
 try{current=JSON.parse(sessionStorage.getItem('arc-visit-session')||'null')}catch{}
 const sessionId=()=>{
  if(!current||Date.now()-current.last>30*60*1000)current={id:crypto.randomUUID(),last:Date.now()};
  current.last=Date.now();try{sessionStorage.setItem('arc-visit-session',JSON.stringify(current))}catch{}
  return current.id;
 };
 const send=page=>{
  try{
   if(localStorage.getItem('arc-visit-exclude')==='1')return;
   const body=JSON.stringify({event_id:crypto.randomUUID(),session_id:sessionId(),page});
   fetch('/api/visit',{method:'POST',headers:{'Content-Type':'application/json'},body,keepalive:true}).catch(()=>{});
  }catch{}
 };
 let pending=location.pathname;
 const view=page=>{if(document.visibilityState==='visible')send(page);else pending=page};
 document.addEventListener('visibilitychange',()=>{if(pending&&document.visibilityState==='visible'){send(pending);pending=null}});
 if(document.visibilityState==='visible'){send(pending);pending=null}
 window.addEventListener('arc-route',()=>view(location.pathname));
 window.addEventListener('popstate',()=>view(location.pathname));
 window.addEventListener('pageshow',e=>{if(e.persisted)view(location.pathname)});

})();
