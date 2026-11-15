'use strict';
const G=require('./kit/gauges');
const num=v=>typeof v==='number'&&isFinite(v);
const array=v=>Array.isArray(v)&&v.length===6&&v.every(x=>num(x)&&x<=0&&x>=-30);
// Frequencies are correction-bearing samples / valid samples, not knock events or ECU fault counts.
class Run {
    constructor(){this.reset();}
    reset(){this.last=null;this.worst=null;this.bands=Array.from({length:8},()=>({n:0,hit:0}));this.cells=Array.from({length:8},()=>Array.from({length:6},()=>({n:0,hit:0})));this.context=null;}
    add(s){
        if(!s||!s.verified||!array(s.corrections)||!num(s.at)||s.at===this.last) return false;
        this.last=s.at;
        const worst=Math.min(...s.corrections), hit=worst<0;
        this.worst=this.worst===null?worst:Math.min(this.worst,worst);
        if(hit) this.context={at:s.at,boost:num(s.boost)?s.boost:null,lambda:num(s.lambda)?s.lambda:null,rpm:num(s.rpm)?s.rpm:null,worst};
        if(num(s.rpm)&&s.rpm>=0&&s.rpm<8000){
            const row=Math.floor(s.rpm/1000),b=this.bands[row];b.n++;if(hit)b.hit++;
            if(num(s.boost)&&s.boost>=0&&s.boost<3){const c=this.cells[row][Math.floor(s.boost/.5)];c.n++;if(hit)c.hit++;}
        }
        return true;
    }
}
const val=(v,d=1)=>num(v)?v.toFixed(d):'--';
function draw(cv,t,o){
    const {sample:s,run,demo,misfire}=o,valid=s&&s.verified&&array(s.corrections);
    cv.text(demo?'DEMO - SIMULATED IGNITION DATA':'IGNITION & KNOCK MONITOR',24,65,23,demo?t.warn:t.text,{font:'bold'});
    cv.text(valid?'Negative values = timing retard':'Cylinder timing/correction mappings not verified for ROM 00005C64146E06',24,94,19,valid?t.dim:t.warn);
    cv.fillRect(18,112,770,308,'#15171c');
    cv.text('CYLINDER CORRECTIONS',34,139,20,t.text,{font:'bold'});
    cv.text('TIMING',678,139,17,t.dim);
    for(let i=0;i<6;i++){
        const y=174+i*39,v=valid?s.corrections[i]:null;
        cv.text('Cyl '+(i+1),36,y,20,t.dim);
        cv.roundRect(123,y-15,410,15,7,'#2c3038');
        if(num(v)&&v<0)cv.roundRect(123,y-15,Math.max(3,410*Math.min(1,-v/4)),15,7,v<=-3?'#e85c55':v<=-1.5?'#e5a43d':'#48b497');
        cv.text(val(v)+'°',620,y,24,num(v)?t.text:t.dim,{align:'right'});
        const timing=s&&Array.isArray(s.timing)&&s.timing[i];
        cv.text(val(s&&s.verified?timing:null)+'°',750,y,21,t.dim,{align:'right'});
    }
    cv.text('Worst this run: '+val(run.worst)+'°',34,403,21,t.text);
    const c=run.context;
    cv.text('Latest correction: '+(c?'RPM '+val(c.rpm,0)+' | boost '+val(c.boost,2)+' bar | lambda '+val(c.lambda,2):'--'),24,447,18,t.dim);
    cv.text('RPM / BOOST HEATMAP',826,140,20,t.text,{font:'bold'});
    cv.text('Correction-bearing samples (%) | blank = no samples',826,166,16,t.dim);
    for(let col=0;col<6;col++)cv.text((col*.5).toFixed(1),967+col*70,191,16,t.dim,{align:'center'});
    for(let row=0;row<8;row++){
        const y=208+row*23,b=run.bands[row];
        cv.text(row+'-'+(row+1)+'k',826,y+15,16,t.dim);
        for(let col=0;col<6;col++){
            const c=run.cells[row][col],ratio=c.n?c.hit/c.n:null,x=936+col*70;
            cv.fillRect(x,y,65,20,ratio===null?'#23262d':ratio>.5?'#a84440':ratio>0?'#a4792c':'#245b50');
            cv.text(ratio===null?'--':String(Math.round(ratio*100)),x+32,y+15,14,t.text,{align:'center'});
        }
        cv.text(b.n?Math.round(100*b.hit/b.n)+'%':'--',1415,y+15,16,t.dim);
    }
    cv.text('Boost bins: 0.5 bar | RPM bands: 1000 | right: band frequency',826,410,16,t.dim);
    cv.text('Mean retard (candidate) '+val(o.mean)+'° | per-cylinder knock status: unavailable',826,439,17,t.dim);
    const rows=Array.from({length:6},(_,i)=>{
        const r=!demo&&misfire.latest[0xA2+i],p=r&&r.parsed,sel=p&&p.status==='parsed'&&p.selected;
        return sel&&sel.tid===12&&sel.uasid===36?String(sel.rawValue):'--';
    });
    cv.text('Misfire raw C1-6: '+rows.join(' / ')+' | verified counts: --',24,480,18,t.dim);
    const rawTimes=!demo?Object.values(misfire.latest).map(r=>Date.parse(r.responseTimestampUtc)).filter(num):[];
    cv.text('Raw snapshot age '+(rawTimes.length?Math.max(0,(Date.now()-Math.min(...rawTimes))/1000).toFixed(1)+' s':'--')+'; sequential samples, counts unverified.',24,506,16,t.dim);
    G.button(cv,t,1030,465,260,40,'Update raw monitors',o.refresh,{busy:!misfire.stationary()||misfire.busy,key:'ignition-raw'});
    G.button(cv,t,1302,465,274,40,'Export report / USB',o.export,{busy:!misfire.stationary(),key:'ignition-export'});
    G.button(cv,t,1320,57,256,35,'Reset run',o.reset,{busy:!misfire.stationary(),key:'ignition-reset'});
}
module.exports={Run,draw};
