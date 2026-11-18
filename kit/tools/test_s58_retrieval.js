'use strict';
const assert=require('assert');
const {Diag}=require('../runtime/diag');
const {ReadOnlyDiag}=require('../runtime/readonly-diag');
const Car=require('../runtime/car');
const Module=require('module'),path=require('path'),load=Module._load;
Module._load=function(r,p,m){return load.call(this,r.startsWith('./kit/')?path.join(__dirname,'../runtime',r.slice(6)):r,p,m);};
const M=require('../../apps/carrajaula_s58/misfire');
Module._load=load;
const log={info(){},warn(){},error(){}};
(async()=>{
 const saved=Diag.prototype.physical,calls=[];
 Diag.prototype.physical=async function(target,sid,data,timeout,accept,opts){calls.push({timeout,opts});return [0x7F,sid,0x31];};
 try{
  const bounded=new ReadOnlyDiag({},log,{requestTimeoutMs:1500,gapMs:1});
  for(const [sid,data,timeout] of [[0x22,[0x42,5],1500],[0x2C,[0x88,1],1500],[6,[0xA2],4000]])
   await bounded.physical(0x12,sid,data,timeout,null,{pendingTimeoutMs:10000,hardTimeoutMs:4000,maxRetries:4});
  for(const c of calls){assert.equal(c.timeout,1500);assert.equal(c.opts.hardTimeoutMs,1500);assert.equal(c.opts.pendingTimeoutMs,1500);assert.equal(c.opts.callTimeoutMs,1500);assert.equal(c.opts.maxRetries,0);}
  calls.length=0;
  await new ReadOnlyDiag({},log).physical(0x12,0x22,[0x42,5],4000);
  assert.equal(calls[0].timeout,4000);assert.equal(calls[0].opts,undefined,'other apps keep their existing transport policy');
  const debug=new M.Debugger({link:bounded,settings:{get:k=>k==='misfireTimeout'?4:undefined}});
  assert.equal(debug.timeout(),1500,'debugger reports the effective request deadline');
 }finally{Diag.prototype.physical=saved;}
 // Repeated pending replies cannot reset the hard deadline forever.
 const d=new Diag({},log);let pulse;
 d.send=async()=>{pulse=setInterval(()=>d.emit('frame',{ecu:0x12,uds:[0x7F,0x22,0x78]}),5);return 'NO_ERROR';};
 const begin=Date.now();try{assert.equal(await d.physical(0x12,0x22,[0x42,5],10,null,{hardTimeoutMs:50,pendingTimeoutMs:40}),null);}finally{clearInterval(pulse);}
 assert(Date.now()-begin<400);assert(d.lastPhysical.pending>1);assert.equal(d.listenerCount('frame'),0);
 const interval=global.setInterval;let fields;
 global.setInterval=()=>0;
 try{
  const car=new Car({spec:{config:{}},log,signals:{watch(i,n,h){fields=h;return Promise.resolve({});}}},['temps']);
  fields.statusEngineTemperature({temperatureEngineOilDrive:142,temperatureEngineDrive:135});
  assert.equal(car.data().oil,94);assert.equal(car.data().coolant,87);
  fields.statusEngineTemperature({temperatureEngineOilDrive:255,temperatureEngineDrive:136});
  assert.equal(car.data().oil,undefined,'invalid oil clears its previous value');assert.equal(car.data().coolant,88);
  fields.statusEngineTemperature({temperatureEngineOilDrive:143});
  assert.equal(car.data().oil,95);assert.equal(car.data().coolant,undefined,'missing coolant clears independently');
  fields.statusEngineTemperature({temperatureEngineOilDrive:143,temperatureEngineDrive:136});
  assert.equal(car.data().oil,95);assert.equal(car.data().coolant,88,'valid readings recover');
 }finally{global.setInterval=interval;}
 console.log('S58 retrieval: bounded requests, pending deadline, debugger timeout, unchanged default link and invalid temperature recovery passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
