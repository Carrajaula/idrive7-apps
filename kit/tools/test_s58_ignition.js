'use strict';
const assert=require('assert'),path=require('path'),Module=require('module');
const ROOT=process.env.S58_TEST_ROOT||path.resolve(__dirname,'../..'),load=Module._load;
Module._load=function(r,p,m){return load.call(this,r.startsWith('./kit/')?path.join(ROOT,'kit/runtime',r.slice(6)):r,p,m);};
const {Run,draw}=require(path.join(ROOT,'apps/carrajaula_s58/ignition'));Module._load=load;
const r=new Run(),s={at:1,verified:false,rpm:3200,boost:1.1,lambda:.85,corrections:[0,-.8,0,-1.5,0,-3]};
assert.equal(r.add(s),false);assert.equal(r.worst,null);assert(!r.context);
s.verified=true;assert(r.add(s));assert.equal(r.worst,-3);assert.equal(r.bands[3].n,1);assert.equal(r.cells[3][2].hit,1);assert.equal(r.context.lambda,.85);assert(!r.add(s),'same sample must not inflate statistics');
r.add({...s,at:2,corrections:[0,0,0,0,0,0]});assert.equal(r.bands[3].hit/r.bands[3].n,.5);assert.equal(r.worst,-3);
assert(!r.add({...s,at:3,corrections:[0,0,0,0,0,NaN]}));
r.add({...s,at:4,rpm:8000,boost:3.5});assert.equal(r.bands.reduce((n,b)=>n+b.n,0),2,'out-of-chart samples are not clamped into edge bins');
r.reset();assert.equal(r.worst,null);assert(!r.context);assert(r.bands.every(b=>!b.n));
const {Recorder}=require(path.join(ROOT,'kit/runtime/record')),t=require(path.join(ROOT,'kit/runtime/themes')).theme('m_red');
const cv=new Recorder(1600,520);cv.own=true;const texts=[],text=cv.text.bind(cv);cv.text=(s,...a)=>{texts.push(s);return text(s,...a);};
draw(cv,t,{sample:null,run:r,demo:false,mean:0,misfire:{latest:{},stationary:()=>true},refresh(){},export(){},reset(){}});
assert(texts.some(s=>s.includes('not verified')));assert(texts.some(s=>s.includes('verified counts: --')));assert(cv.targets.some(x=>x.key==='ignition-export'));
console.log('Ignition: verified-data gate, missing values, sample deduplication, run worst, context, RPM/boost frequency, out-of-range bins and reset passed.');

// Hiding is reversible and applies to the native bar as well as renderer-owned controls.
const {Display}=require(path.join(ROOT,'kit/runtime/display'));
let own=false;const visibility={};
const display={screen:{buttons:[['BTN_DEBUG','Debug']]},ownHidden:new Set(),hiddenButtons:new Set(),labels:{},
 ownable:()=>own,ui:{visible:(id,on)=>visibility[id]=on},blocked:false,place:null};
display._hmiBar=()=>Display.prototype._hmiBar.call(display);
Display.prototype.hideButton.call(display,'BTN_DEBUG',true,true);
assert.equal(visibility.BTN_DEBUG,false);assert.equal(Display.prototype.buttons.call(display).length,0);
own=true;display._btns=null;assert.equal(Display.prototype.buttons.call(display).length,0);
own=false;Display.prototype.hideButton.call(display,'BTN_DEBUG',false,true);
assert.equal(visibility.BTN_DEBUG,true);assert.equal(Display.prototype.buttons.call(display).length,1);
