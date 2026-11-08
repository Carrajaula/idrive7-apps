'use strict';
// All responses here are synthetic, not captures from an S58.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const ROOT = process.env.S58_TEST_ROOT || path.resolve(__dirname, '../..');
const Module = require('module'), originalLoad = Module._load;
Module._load = function(req, parent, main) { return originalLoad.call(this, req.startsWith('./kit/') ? path.join(ROOT, 'kit/runtime', req.slice(6)) : req, parent, main); };
const M = require(path.join(ROOT, 'apps/carrajaula_s58/misfire'));
Module._load = originalLoad;
const { check, ReadOnlyDiag } = require(path.join(ROOT, 'kit/runtime/readonly-diag'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's58-misfire-'));
const rec = (mid, tid=12, unit=36, value=13) => [mid,tid,unit,value>>8,value&255,0,0,255,255];
const response = (mode,mid,tid=12,unit=36,value=13) => mode==='mode06' ? [70].concat(rec(mid,tid,unit,value)) : [98,246,mid].concat(rec(mid,tid,unit,value).slice(1));
const quiet = { info() {}, warn() {} };
(async()=>{
    let p = M.parse('mode06',164,response('mode06',164));
    assert.equal(p.status,'parsed'); assert.equal(p.selected.rawValue,13); assert.equal(p.selected.scaledValue,13);
    assert.equal(p.selected.unit,'counts'); assert.equal(p.interpretationVerified,false);
    assert.equal(p.selected.minimum,0); assert.equal(p.selected.maximum,65535);
    assert.equal(p.selected.returnedMid,164);
    p=M.parse('uds',164,response('uds',164)); assert.equal(p.selected.rawValue,13); assert.equal(p.interpretationVerified,false);
    p=M.parse('mode06',162,[70].concat(rec(162,11,36,9),rec(162,12,36,258)));
    assert.equal(p.tests.length,2); assert.equal(p.selected.rawValue,258,'big endian');
    p=M.parse('mode06',162,response('mode06',162,11)); assert.equal(p.status,'ambiguous'); assert.equal(p.selected,null);
    p=M.parse('mode06',162,response('mode06',162,11),11); assert.equal(p.selected.tid,11);
    p=M.parse('mode06',162,response('mode06',162,12,254)); assert.equal(p.selected.scaledValue,null); assert.equal(p.selected.unit,null);
    assert.equal(p.selected.status,'unknown UASID');
    p=M.parse('mode06',162,response('mode06',162,12,1)); assert.equal(p.selected.unit,'raw'); assert.equal(p.interpretationVerified,false);
    assert.equal(M.scale(2,123).value,12.3); assert.equal(M.scale(36,65535).value,65535);
    assert.equal(M.parse('mode06',162,[127,6,49]).status,'unsupported');
    assert.equal(M.parse('uds',162,[127,34,34]).status,'negative response');
    for(const bytes of [[70,162],response('mode06',162).concat(0),response('mode06',162).slice(0,-1),[70,162,12,36,0,256]]) {
        p=M.parse('mode06',162,bytes); assert.equal(p.status,'malformed'); assert.deepEqual(p.rawResponse,bytes);
    }
    p=M.parse('mode06',162,response('mode06',163)); assert.equal(p.status,'wrong MID'); assert.equal(p.tests[0].returnedMid,163); assert.equal(p.selected,null);
    p=M.parse('uds',162,response('uds',163)); assert.equal(p.status,'wrong MID');
    p=M.parse('mode06',162,[70].concat(rec(162),rec(162))); assert.equal(p.status,'ambiguous');
    assert.equal(M.parse('mode06',162,null).status,'timeout');
    p=M.parse('mode06',160,[70,160,0x7E,0,0,0]); assert.deepEqual(p.supported,[162,163,164,165,166,167]);
    assert.equal(M.parse('uds',160,[98,246,160,0,0,0,0]).status,'parsed');
    // Exact read-only allowlist, no generic Mode 06 access.
    for (const mid of [160,162,163,164,165,166,167]) assert.doesNotThrow(()=>check(18,6,[mid],false));
    for (const args of [[18,6,[161],false],[24,6,[162],false],[18,6,[162,0],false],[223,6,[162],true]]) assert.throws(()=>check(...args));
    for(let mid=0;mid<256;mid++) if(M.MIDS.indexOf(mid)<0) assert.throws(()=>check(18,6,[mid],false));
    for(let ecu=0;ecu<256;ecu++) if(ecu!==18) assert.throws(()=>check(ecu,6,[162],false));
    let sample=13, busy=0, maxBusy=0, modeFail=false, release=null;
    const settings={misfireProtocol:'auto',misfireTimeout:4,misfireInterval:10};
    const sent=[];
    const link={available:true, silent:()=>false,wake(){},stats:{sent:0}, async physical(ecu,sid,data,timeout,accept,opts){
        check(ecu,sid,data,false); sent.push([sid].concat(data)); assert.equal(timeout,4000); assert.equal(opts.hardTimeoutMs,4000); assert.equal(opts.maxRetries,0); this.stats.sent++;
        busy++; maxBusy=Math.max(maxBusy,busy);
        if(release) await new Promise(r=>{ release=r; });
        const mid=data[data.length-1], mode=sid===6?'mode06':'uds';
        const bytes=modeFail&&sid===6 ? [127,6,17] : mid===160 ? (sid===6?[70,160,126,0,0,0]:[98,246,160,126,0,0,0]) : response(mode,mid,12,36,sample);
        busy--; assert(accept(bytes)); return bytes;
    }};
    const telemetry=()=>({speed:0,rpm:800,boost:0,ethanolActive:8});
    const d=new M.Debugger({link,settings:{get:k=>settings[k]},log:quiet,dataDir:dir,telemetry});
    const drain=async()=>{for(let i=0;i<30&&d.jobs.length;i++) await d.step();};
    d.refresh(); await drain(); assert.equal(d.mode,'mode06'); assert.equal(d.summary().rawSum,78); assert.equal(d.summary().misfireCount,null);
    assert(d.records.every(r=>r.interpretationVerified===false));
    sample=15; d.refresh(); await drain(); assert.equal(d.latest[162].rawDelta,2);
    d.resetBaseline(); assert.equal(d.baselines[162].raw,15);
    sample=4; d.refresh(); await drain(); assert.equal(d.latest[162].rawDelta,null); assert(d.latest[162].change.includes('decrease')); assert(!d.baselines[162]);
    d.selectTid(162,11); d.refresh(162); await drain(); assert.equal(d.latest[162].parsed.status,'ambiguous'); assert.equal(d.summary().rawSum,null);
    d.selectTid(162,12);
    settings.misfireProtocol='auto'; d.mode=null; modeFail=true; d.refresh(); await drain();
    assert.equal(d.mode,'uds'); assert(sent.some(s=>s.join(' ')==='34 246 162')); assert(d.records.some(r=>r.status==='unsupported'));
    settings.misfireProtocol='mode06'; modeFail=false; d.refresh(164); await drain(); assert.equal(d.latest[164].protocol,'mode06');
    // Stopping an in-flight request preserves its raw reply but cannot update live tiles.
    const previous=d.latest[164]; release=true; d.refresh(164); const a=d.step(); await Promise.resolve(); const b=d.step();
    d.stop('test cancellation'); release(); release=null; await a; await b;
    assert.equal(maxBusy,1); assert.strictEqual(d.latest[164],previous); assert.equal(d.records[d.records.length-1].status,'cancelled');
    assert(d.records[d.records.length-1].responseHex.includes('46 A4'));
    d.start(); d.stop('app hidden'); const count=sent.length; await d.step(); assert.equal(sent.length,count);
    // Errors and data survive in exports, including all TIDs and snapshots.
    const files=await d.export(); assert(fs.existsSync(files.json)&&fs.existsSync(files.csv));
    const out=JSON.parse(fs.readFileSync(files.json)); assert.equal(out.records.length,d.records.length); assert.equal(out.records[0].telemetry.ethanolActive,8);
    assert(fs.readFileSync(files.csv,'utf8').includes('responseHex'));
    await d.flush(); assert(fs.readFileSync(d.captureFile,'utf8').includes('"responseHex"'));
    assert.equal(M.classify({speed:0,rpm:800},null),'idle'); assert.equal(M.classify({rpm:800},null),'unknown');
    assert.equal(M.classify({speed:90,rpm:2200},{speed:90,elapsed:2}),'steady cruising');
    // A moving or unknown-speed car cannot invoke raw/manual/export interactions.
    // Explicit timeout and malformed replies remain inspectable and cannot create a total.
    const savedPhysical=link.physical;
    link.physical=async()=>null; d.refresh(162); await drain(); assert.equal(d.latest[162].status,'timeout'); assert.equal(d.latest[162].responseHex,null);
    link.physical=async()=>[70,162,12,36,0]; d.refresh(162); await drain(); assert.equal(d.latest[162].status,'malformed'); assert.equal(d.latest[162].responseHex,'46 A2 0C 24 00');
    link.physical=savedPhysical;
    // Configured polling is asynchronous and cannot issue overlapping cycles.
    const originalNow=Date.now; let clock=Date.now(); Date.now=()=>clock;
    try {
        d.start(); await drain(); const before=sent.length; await d.step(); assert.equal(sent.length,before);
        let paused=true; link.silent=()=>paused; link.wake=()=>{paused=false;};
        clock+=10001; await d.step(); assert.equal(sent.length,before+1,'a new scan must wake a local pause left by other telemetry'); assert(!paused); d.stop(); await drain();
        link.silent=()=>false;
    } finally { Date.now=originalNow; }
    // Use the real shared queue for a normal DID read competing with Mode 06.
    let onResponse, concurrent=0, peak=0;
    const realSignals={proxy:async()=>({}),on:async(p,n,f)=>{onResponse=f;},onAvailable:async(p,f)=>f(true),call:async(p,n,a)=>{
        concurrent++; peak=Math.max(peak,concurrent);
        const mid=a.udsData[a.udsData.length-1];
        setTimeout(()=>{
            concurrent--;
            const uds=a.serviceID===6 ? mid===163?[127,6,120]:response('mode06',mid) : [98].concat(Array.from(a.udsData),[0]);
            onResponse({errorCode:'NO_ERROR',udsResponse:[0,0,0,0,0,0,a.targetAddress,0,0].concat(uds)});
        },5); return 'NO_ERROR';
    }};
    const serial=await new ReadOnlyDiag(realSignals,{info(){},warn(){},error(){}},{gapMs:1}).init();
    const actual=await Promise.all([serial.read(18,0x554C,100),serial.physical(18,6,[162],100,u=>u[0]===70&&u[1]===162)]);
    assert.equal(actual[1][1],162); assert.equal(peak,1,'telemetry and inspector share the same serial request queue');
    const began=Date.now();
    assert.equal(await serial.physical(18,6,[163],200,u=>u[0]===70,{hardTimeoutMs:30,pendingTimeoutMs:200}),null);
    assert(Date.now()-began<150,'read-only wrapper forwards hard deadline through response pending');
    // The existing renderer targets expose controls without a second UI framework.
    const {Recorder}=require(path.join(ROOT,'kit/runtime/record'));
    const theme=require(path.join(ROOT,'kit/runtime/themes')).theme('m_red');
    const cv=new Recorder(1600,520); cv.own=true; M.draw(cv,theme,d,()=>{});
    assert(cv.targets.some(t=>t.key==='mf-Refresh / Retry'));
    cv.targets.find(t=>t.key==='mf-Inspector').run(); assert(d.inspector);
    d.action('nextmid'); assert.equal(d.selectedMid,163); d.selectedMid=162;
    d.action('next'); assert.equal(d.page,1); d.action('previous'); assert.equal(d.page,0);
    const lines=M.inspectorLines(d).join(' '); assert(lines.includes('TX ')&&lines.includes('interpretation UNVERIFIED'));
    const lastCount=sent.length;
    const moving=new M.Debugger({link,settings:{get:k=>settings[k]},log:quiet,dataDir:dir,telemetry:()=>({speed:50})});
    assert.equal(moving.refresh(162),false); await assert.rejects(moving.export(),/stationary/i);
    assert.equal(sent.length,lastCount);
    console.log('Misfire debugger: synthetic parser, UASID, fallback, raw evidence, deltas, cancellation, serial access and export checks passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
