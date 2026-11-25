'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {plain,snippet,verdict,digest,botName,collapseChecks,Watcher}=require('./pr-wait.cjs');
test('review bot recognition',()=>{assert.equal(botName('Greptile Review'),'greptile');assert.equal(botName('CodeRabbit'),'coderabbit');assert.equal(botName('build'),undefined);});
test('comment formatting and hashing',()=>{assert.equal(plain('a<!--hidden--><b>b</b>&amp;'),'a  b &');assert.equal(snippet('one   two'),'one two');assert.equal(verdict('**Confidence score:** 4/5'),'Confidence score: 4/5');assert.equal(digest('a  b'),digest('a b'));});
test('duplicate checks keep worst status',()=>{assert.equal(collapseChecks([{name:'CI',bucket:'pass'},{name:'CI',bucket:'fail'}]).get('CI').bucket,'fail');});
function fixture(until='green',bucket='pass',merge='CLEAN'){
  const w=new Watcher('fixture/test',123456,until,5);
  w.required=new Set(['CI']);w.requiredBase='main';w.baseline=false;w.reported=new Set();w.state={reported:[],summaries:{},base_oid:null,merge_state:null};
  w.fetchPR=async()=>({state:'OPEN',headRefOid:'abcdef0123456789',baseRefName:'main',mergeStateStatus:merge,author:{login:'author'},viewer:'viewer',comments:{nodes:[]},reviews:{nodes:[]},reviewThreads:{nodes:[]}});
  w.fetchChecks=async()=>collapseChecks([{name:'CI',bucket,link:'https://example.com/ci'},{name:'Greptile',bucket:'pass'},{name:'CodeRabbit',bucket:'pending'}]);
  w.save=()=>{};w.say=()=>{};w.behind=async()=>'';
  return w;
}
test('green requires two matching polls and ignores advisory bot',async()=>{const w=fixture();assert.equal(await w.poll(),null);assert.equal(await w.poll(),0);});
test('required failure and dirty branches block immediately',async()=>{assert.equal(await fixture('ready','fail').poll(),1);assert.equal(await fixture('ready','pass','DIRTY').poll(),1);});
test('ready waits for gating bot and blocks behind branches',async()=>{const w=fixture('ready','pass','BEHIND');assert.equal(await w.poll(),null);assert.equal(await w.poll(),1);});
