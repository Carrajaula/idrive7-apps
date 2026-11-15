'use strict';
const assert=require('assert'),path=require('path'),ROOT=process.env.S58_TEST_ROOT||path.resolve(__dirname,'../..');
const P=require(path.join(ROOT,'apps/carrajaula_s58/poll-plan'));
const keys=['boostAbs','baro','lambda','rail','unknown'];let cursor=0,seen=[];
for(let i=0;i<4;i++){const p=P.plan(keys,{},0,cursor);cursor=p.cursor;assert.equal(p.work[0],'boostAbs');assert.equal(p.work.length,2);seen.push(p.work[1]);}
assert.deepEqual(seen,['baro','lambda','rail','unknown']);
assert.deepEqual(P.plan(keys,{baro:100,lambda:100,rail:100,unknown:100},0,0).work,['boostAbs']);
assert.deepEqual(P.plan(keys.filter(k=>k!=='boostAbs'),{},0,0).work,['baro']);
assert.deepEqual(P.plan(keys,{},2000,3,{rail:{at:0},baro:{at:100}}).work,['boostAbs','rail'],'ageing working data precedes an unknown probe');
assert.equal(P.interval('baro'),2000);assert.equal(P.interval('lambda'),200);
console.log('Polling: boost priority, bounded work, fair background reads, due times and boost-backoff behavior passed.');
