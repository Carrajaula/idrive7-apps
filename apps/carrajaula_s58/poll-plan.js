'use strict';
// One boost read, then at most one other read: slow probes cannot queue a whole sweep ahead of boost.
function plan(keys,due,now,cursor,live={}){
    const work=keys.includes('boostAbs')?['boostAbs']:[],rest=keys.filter(k=>k!=='boostAbs');
    // Refresh ageing working data before spending another slot probing an unsupported source.
    const ageing=rest.filter(k=>live[k]&&now>=(due[k]||0)&&now-live[k].at>=1000).sort((a,b)=>live[a].at-live[b].at);
    if(ageing.length){work.push(ageing[0]);return {work,cursor};}
    for(let n=0;n<rest.length;n++){
        const i=(cursor+n)%rest.length,k=rest[i];
        if(now>=(due[k]||0)){work.push(k);return {work,cursor:(i+1)%rest.length};}
    }
    return {work,cursor};
}
const interval=k=>['baro','boostTarget','iat','charge','gearbox','ethanolActive'].includes(k)?2000:200;
module.exports={plan,interval};
