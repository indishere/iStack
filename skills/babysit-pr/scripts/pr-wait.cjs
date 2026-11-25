#!/usr/bin/env node
'use strict';
// Adapted from t3dotgg/tstack pr-wait, MIT, Copyright (c) 2026 Theo Browne.
// See LICENSE.tstack.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const {parseArgs} = require('node:util');
const {setTimeout: sleep} = require('node:timers/promises');

const GATING = ['greptile', 'macroscope'];
const ADVISORY = ['coderabbit'];
const BOTS = [...GATING, ...ADVISORY];
const STATUS = ['github-actions', 'vercel', 'netlify', 'railway', 'cloudflare'];
const FAILED = new Set(['fail', 'cancel']);
const DONE = new Set(['pass','skipping','fail','cancel']);
const RANK = {fail:4, cancel:3, pending:2, pass:1, skipping:0};
const DIR = path.join(os.homedir(), '.local', 'state', 'pr-wait');
const TRANSIENT = /HTTP (5\d\d|429)|rate limit|timed? ?out|connection (reset|refused)|EOF|temporar|could not resolve host|TLS handshake|Something went wrong/i;
const QUERY = 'query($owner: String!, $name: String!, $number: Int!) { viewer { login } repository(owner: $owner, name: $name) { pullRequest(number: $number) { url state headRefOid baseRefName mergeStateStatus author { login } baseRef { target { oid } } comments(last: 100) { nodes { id url body author { login __typename } } } reviews(last: 100) { nodes { id url state body commit { oid } author { login __typename } } } reviewThreads(last: 100) { nodes { isResolved path line comments(first: 100) { nodes { id url body author { login __typename } } } } } } } }';

class GhError extends Error {
  constructor(message, transient = false) { super(message); this.transient = transient; }
}
const log = message => console.error('pr-wait: '+message);
const fatal = (message, code=2) => { console.log('pr-wait: '+message); process.exitCode=code; };
async function gh(args, allow=[0]) {
  for (let attempt=0; attempt<5; attempt++) {
    const p=spawnSync('gh',args,{encoding:'utf8',maxBuffer:64*1024*1024,timeout:60000,windowsHide:true});
    const stderr=p.stderr||'', stdout=p.stdout||'';
    const transient=p.status!==0 && (TRANSIENT.test(stderr) || p.error?.code==='ETIMEDOUT');
    if (!p.error && !transient && allow.includes(p.status)) return {stdout,stderr,status:p.status};
    const message=p.error?.message || stderr.trim().split(/\r?\n/).at(-1) || 'gh exited '+p.status;
    if (!transient || attempt===4) throw new GhError(message,transient);
    const delay=2**(attempt+1);
    log('gh '+args.slice(0,2).join(' ')+': '+message+'; retry in '+delay+'s');
    await sleep(delay*1000);
  }
}
const lines=async args=>(await gh(args)).stdout.split(/\r?\n/).filter(Boolean);
const botName=s=>BOTS.find(b=>(s||'').toLowerCase().includes(b));
const who=n=>n.author?.login||'ghost';
const isBot=n=>n.author?.__typename==='Bot';
function plain(body) {
  const entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',ndash:'–',mdash:'—',hellip:'…'};
  return (body||'').replace(/<!--[\s\S]*?-->/g,' ').replace(/<[^>]+>/g,' ').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,(m,k)=>{
    if(k[0]==='#'){
      const n=k[1].toLowerCase()==='x'?parseInt(k.slice(2),16):Number(k.slice(1));
      return n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):'\ufffd';
    }
    return Object.hasOwn(entities,k)?entities[k]:m;
  });
}
const snippet=(body,limit=100)=>{const s=plain(body).replace(/\s+/g,' ').trim();return s.length<=limit?s:s.slice(0,limit-3)+'...';};
const verdict=body=>{const l=plain(body).split(/\r?\n/).find(s=>/verdict|confidence score/i.test(s));return l?snippet(l.replace(/\*/g,''),80):'';};
const digest=body=>createHash('sha1').update(plain(body).replace(/\s+/g,' ')).digest('hex').slice(0,12);
async function target(raw,repo){
  if(!raw?.trim())throw Error('missing PR number. Usage: pr-wait <pr> [--repo owner/name]');
  const u=raw.trim().match(/^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#]\S*)?$/);
  const n=raw.trim().match(/^#?(\d+)$/);
  const pr=Number(u?.[2]||n?.[1]);
  if(!Number.isSafeInteger(pr)||pr<=0)throw Error("'"+raw+"' is not a valid PR number or URL");
  repo=repo||u?.[1];
  if(!repo)repo=(await gh(['repo','view','--json','nameWithOwner','--jq','.nameWithOwner'])).stdout.trim();
  if(!/^[\w.-]+\/[\w.-]+$/.test(repo))throw Error("'"+repo+"' is not owner/name");
  try{await gh(['pr','view',String(pr),'-R',repo,'--json','number']);}
  catch(e){if(!e.transient)throw Error('cannot read '+repo+'#'+pr+': '+e.message);}
  return {repo,pr};
}
function acquireLock(repo,pr) {
  fs.mkdirSync(DIR,{recursive:true,mode:0o700});
  const file=path.join(DIR,repo.toLowerCase().replace('/','__')+'__'+pr+'.node.lock');
  let fd;
  try{fd=fs.openSync(file,'wx',0o600);}
  catch(e){
    if(e.code!=='EEXIST')throw e;
    let pid='unknown';try{pid=fs.readFileSync(file,'utf8').trim()||pid;}catch{}
    throw Error('pid '+pid+' already watches '+repo+'#'+pr+' or left a stale lock. Verify the process stopped before removing '+file);
  }
  let released=false;
  const release=()=>{if(released)return;released=true;try{fs.closeSync(fd);}catch{}try{fs.unlinkSync(file);}catch{}};
  try{fs.writeFileSync(fd,String(process.pid));}catch(e){release();throw e;}
  process.once('exit',release);
  for(const [sig,code] of [['SIGINT',130],['SIGTERM',143],['SIGHUP',129]])process.once(sig,()=>{release();process.exit(code);});
  return release;
}
async function requiredChecks(repo,base){
  const names=new Set();
  for(const [endpoint,jq] of [
    ['repos/'+repo+'/rules/branches/'+encodeURIComponent(base),'.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context'],
    ['repos/'+repo+'/branches/'+encodeURIComponent(base)+'/protection/required_status_checks','.contexts[]?, .checks[]?.context']
  ]){
    try{for(const n of await lines(['api',endpoint,'--jq',jq]))names.add(n);}
    catch(e){if(!e.message.includes('HTTP 404'))log('could not read required checks from '+endpoint+': '+e.message);}
  }
  return names;
}
function collapseChecks(rows){
  const checks=new Map();
  for(const row of rows){
    const old=checks.get(row.name);
    if(!old||(RANK[row.bucket]??2)>(RANK[old.bucket]??2))checks.set(row.name,row);
  }
  return checks;
}
class Watcher {
  constructor(repo,pr,until,interval){
    Object.assign(this,{repo,pr,until,interval});
    [this.owner,this.name]=repo.split('/');
    this.file=path.join(DIR,repo.toLowerCase().replace('/','__')+'__'+pr+'.json');
    let state;
    try{if(Date.now()-fs.statSync(this.file).mtimeMs<=6*3600000)state=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{}
    if(!state||!Array.isArray(state.reported)||!state.summaries||typeof state.summaries!=='object')state=null;
    this.baseline=!state;
    this.state=state||{reported:[],summaries:{},base_oid:null,merge_state:null};
    this.reported=new Set(this.state.reported);
    this.printed=new Set();
    this.required=null;this.requiredBase=null;this.prev=null;this.events=0;this.prFiles=new Map();
  }
  save(){
    this.state.reported=[...this.reported].sort();
    const tmp=this.file+'.'+process.pid+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify(this.state),{mode:0o600});
    fs.renameSync(tmp,this.file);
  }
  say(line){if(!this.printed.has(line)){this.printed.add(line);console.log('#'+this.pr+' '+line);}}
  emit(key,line){if(this.reported.has(key))return;this.reported.add(key);if(!this.baseline){this.events++;this.say(line);}}
  finish(code,events=[]){events.forEach(s=>this.say(s));this.save();return code;}
  async fetchPR(){
    const {stdout}=await gh(['api','graphql','-f','query='+QUERY,'-f','owner='+this.owner,'-f','name='+this.name,'-F','number='+this.pr]);
    const data=JSON.parse(stdout).data;
    if(!data?.repository?.pullRequest)throw new GhError('pull request unavailable');
    return {...data.repository.pullRequest,viewer:data.viewer?.login};
  }
  async fetchChecks(){
    const p=await gh(['pr','checks',String(this.pr),'-R',this.repo,'--json','name,bucket,link,description'],[0,1,8]);
    if(!p.stdout.trim()){
      if(p.stderr.includes('no checks reported'))return new Map();
      throw new GhError(p.stderr.trim()||'gh pr checks exited '+p.status);
    }
    return collapseChecks(JSON.parse(p.stdout));
  }
  async overlap(head,old,next){
    try{
      if(!this.prFiles.has(head))this.prFiles.set(head,new Set(await lines(['pr','diff',String(this.pr),'-R',this.repo,'--name-only'])));
      const moved=await lines(['api','repos/'+this.repo+'/compare/'+old+'...'+next,'--jq','.files[].filename']);
      return [...new Set(moved.filter(f=>this.prFiles.get(head).has(f)))].sort();
    }catch(e){log('could not compare base commits: '+e.message);return [];}
  }
  async behind(base,oid,head){
    if(!oid)return '';
    try{const count=(await gh(['api','repos/'+this.repo+'/compare/'+oid+'...'+head,'--jq','.behind_by'])).stdout.trim();return '; '+count+' commit'+(count==='1'?'':'s')+' behind '+base;}
    catch{return '';}
  }
  async poll(){
    const pr=await this.fetchPR();
    if(pr.state==='MERGED')return this.finish(0,['merged: '+pr.url]);
    if(pr.state==='CLOSED')return this.finish(1,['closed without merging: '+pr.url]);
    const base=pr.baseRefName;
    if(this.required===null||this.requiredBase!==base){
      this.required=await requiredChecks(this.repo,base);this.requiredBase=base;this.prev=null;
      log('watching '+this.repo+'#'+this.pr+' until '+this.until+'; required checks: '+([...this.required].sort().join(', ')||'none set, so every CI check gates'));
    }
    const checks=await this.fetchChecks(), head=pr.headRefOid, short=head.slice(0,7);
    const mine=new Set([who(pr),pr.viewer]);
    const comments=pr.comments.nodes,reviews=pr.reviews.nodes,threads=pr.reviewThreads.nodes;
    this.events=0;
    const gate=this.required.size?this.required:new Set([...checks.keys()].filter(n=>!botName(n)));
    const label=this.required.size?'required check':'check';
    const bucket=n=>checks.get(n)?.bucket??'pending';
    const failLines=[];
    for(const n of [...gate].sort())if(FAILED.has(bucket(n))){
      const link=checks.get(n).link,line=label+' failed: '+n+' '+link;
      failLines.push(line);this.emit('fail:'+head+':'+n+':'+link,line);
    }
    const watched=[...checks].filter(([n])=>!ADVISORY.includes(botName(n)));
    const gateDone=gate.size>0&&[...gate].every(n=>DONE.has(bucket(n)));
    const allDone=gateDone&&watched.every(([,c])=>DONE.has(c.bucket));
    const snapshot=JSON.stringify([head,watched.map(([n,c])=>[n,c.bucket]).sort((a,b)=>a[0].localeCompare(b[0]))]);
    const stable=snapshot===this.prev;this.prev=snapshot;
    const green=gateDone&&stable&&!failLines.length;
    for(const c of comments){
      const login=who(c);
      if(mine.has(login)||botName(login)||(isBot(c)&&STATUS.some(b=>login.includes(b))))continue;
      this.emit('c:'+c.id,'comment from '+login+': '+snippet(c.body)+' '+c.url);
    }
    for(const r of reviews){
      const login=who(r);
      if(mine.has(login)||isBot(r))continue;
      if(['APPROVED','CHANGES_REQUESTED'].includes(r.state)||r.body.trim())this.emit('c:'+r.id,'review from '+login+' ('+r.state.toLowerCase().replace(/_/g,' ')+'): '+snippet(r.body)+' '+r.url);
    }
    const unresolved=[];
    for(const t of threads){
      const nodes=t.comments.nodes;
      if(!t.isResolved&&nodes.length)unresolved.push(nodes[0].url);
      const where=t.path+(t.line?':'+t.line:'');
      nodes.forEach((c,i)=>{if(!mine.has(who(c)))this.emit('c:'+c.id,(i?'thread reply':'new thread')+' from '+who(c)+' on '+where+': '+snippet(c.body)+' '+c.url);});
    }
    const botStatus=new Map(),reviewed=[];
    for(const bot of BOTS){
      const own=[...checks].filter(([n])=>botName(n)===bot);
      const summaries=comments.filter(c=>botName(who(c))===bot);
      const ownReviews=reviews.filter(r=>botName(who(r))===bot);
      const onHead=ownReviews.some(r=>r.commit?.oid===head);
      const done=own.length?own.every(([,c])=>DONE.has(c.bucket)):onHead||summaries.some(s=>s.body.includes(short));
      const seen=own.length||summaries.length||ownReviews.length;
      if(ADVISORY.includes(bot)&&own.length){const c=own[0][1];botStatus.set(bot,bot+' '+(c.description||c.bucket)+' (advisory)');}
      else if(seen)botStatus.set(bot,bot+' '+(done?'done':'pending')+(ADVISORY.includes(bot)?' (advisory)':''));
      const key='bot:'+bot+':'+head,wasDone=this.reported.has(key);
      if(done){
        if(GATING.includes(bot))reviewed.push(bot);
        const failures=own.filter(([,c])=>FAILED.has(c.bucket)).map(([n])=>n);
        const detail=[summaries.map(s=>verdict(s.body)).find(Boolean),failures.length?'failed: '+failures.join(', '):''].filter(Boolean).join('; ');
        this.emit(key,bot+' finished on '+short+(detail?': '+detail:'')+(ADVISORY.includes(bot)?' (advisory, not waited on)':''));
      }
      if(GATING.includes(bot))for(const s of summaries){
        const next=digest(s.body),old=this.state.summaries[s.id];this.state.summaries[s.id]=next;
        if(wasDone&&old&&old!==next)this.emit('summary:'+s.id+':'+next,bot+' summary changed on '+short+': '+(verdict(s.body)||snippet(s.body))+' '+s.url);
      }
    }
    const baseOid=pr.baseRef?.target?.oid,oldBase=this.state.base_oid;
    if(baseOid&&oldBase&&baseOid!==oldBase&&!this.baseline){
      const touched=await this.overlap(head,oldBase,baseOid);
      if(touched.length)this.emit('base:'+baseOid,base+' moved to '+baseOid.slice(0,7)+' and touches files in this PR: '+touched.slice(0,5).join(', ')+(touched.length>5?' and '+(touched.length-5)+' more':''));
    }
    if(baseOid)this.state.base_oid=baseOid;
    const merge=pr.mergeStateStatus,dirtyLine='merge state is DIRTY: the branch conflicts with '+base+', rebase it',behindLine='merge state is BEHIND: update the branch from '+base+' before merging';
    if(merge!=='UNKNOWN'){
      if(['DIRTY','BEHIND'].includes(merge)&&this.state.merge_state!==merge)this.emit('merge:'+merge+':'+head+':'+baseOid,merge==='DIRTY'?dirtyLine:behindLine);
      this.state.merge_state=merge;
    }
    const counts=new Map();for(const [,c] of watched)counts.set(c.bucket,(counts.get(c.bucket)||0)+1);
    const failedNames=watched.filter(([,c])=>FAILED.has(c.bucket)).map(([n])=>n).sort();
    const summary=[
      [...counts].sort(([a],[b])=>a.localeCompare(b)).map(([b,n])=>n+' '+b).join(', ')+(failedNames.length?' ('+failedNames.join(', ')+')':''),
      this.required.size?'required '+[...this.required].filter(n=>['pass','skipping'].includes(bucket(n))).length+'/'+this.required.size+' green':'',
      BOTS.map(b=>botStatus.get(b)).filter(Boolean).join(', ')||'no Greptile or Macroscope yet',
      unresolved.length+' unresolved threads','merge state '+merge
    ].filter(Boolean).join('; ');
    const key='checks:'+head;
    if(this.until!=='any-change'){
      if(merge==='DIRTY')return this.finish(1,[dirtyLine]);
      if(failLines.length)return this.finish(1,failLines);
      if(green&&this.until==='green'){this.reported.add(key);return this.finish(0,['green on '+short+': '+summary+await this.behind(base,baseOid,head)]);}
      if(green&&reviewed.length){
        if(unresolved.length)return this.finish(1,['blocked by '+unresolved.length+' unresolved threads on '+short+': '+unresolved.join(' ')]);
        if(merge==='BEHIND')return this.finish(1,[behindLine]);
        this.reported.add(key);return this.finish(0,['ready on '+short+': '+summary+await this.behind(base,baseOid,head)]);
      }
    }
    if(allDone&&(stable||this.baseline))this.emit(key,'checks finished on '+short+': '+summary);
    if(this.until==='any-change'&&this.events)return this.finish(0);
    return null;
  }
  async run(){
    let failures=0;
    for(;;){
      try{
        const code=await this.poll();if(code!==null)return code;
        failures=0;this.save();
        if(this.baseline)log('baseline recorded for '+this.repo+'#'+this.pr+'; reporting only new events');
        this.baseline=false;
      }catch(e){
        if(!e.transient)return this.finish(1,['pr-wait stopped: '+e.message]);
        failures++;log('poll failed ('+failures+'/10): '+e.message);
        if(failures>=10)return this.finish(1,['pr-wait stopped: GitHub unreachable for '+failures+' polls: '+e.message]);
      }
      await sleep(this.interval*1000);
    }
  }
}
async function main(){
  let release;
  try{
    const {values:v,positionals:p}=parseArgs({options:{repo:{type:'string'},until:{type:'string',default:'ready'},interval:{type:'string',default:'20'},help:{type:'boolean',short:'h'}},allowPositionals:true});
    if(v.help){console.log('Usage: pr-wait <pr> [--repo owner/name] [--until green|ready|any-change] [--interval 20]');return;}
    if(p.length!==1||!['green','ready','any-change'].includes(v.until)||!/^[-+]?\d+$/.test(v.interval)||!Number.isSafeInteger(Number(v.interval)))throw Error('invalid arguments. Use --help for usage.');
    const {repo,pr}=await target(p[0],v.repo);
    release=acquireLock(repo,pr);
    process.exitCode=await new Watcher(repo,pr,v.until,Math.max(5,Number(v.interval))).run();
  }catch(e){fatal(e.message,release?1:2);}
  finally{release?.();}
}
if(require.main===module)main();
module.exports={Watcher,plain,snippet,verdict,digest,botName,collapseChecks,acquireLock};
