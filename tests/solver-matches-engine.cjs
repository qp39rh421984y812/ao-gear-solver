const P0=require('path').join(__dirname,'..','public')+'/';
require(P0+'js/engine.js'); require(P0+'js/solver.js');
const E=globalThis.AOEngine, SV=globalThis.AOSolver, d=require(P0+'data/equipment.json');
let bad=0, n=0;
for (const [lvl, alloc, exact] of [[175,{},false],[175,{Spirit:200,Magic:150},true],[133,{Strength:200,Weapons:66},true],[100,{Magic:200},false]]) {
  const cfg={level:lvl,allocator:alloc,useShield:true,exact,insMode:'any',targets:[]};
  const P=SV.prepare(d,cfg); const s=SV.makeSearch(P, 7);
  for (let t=0;t<400;t++){
    const st=s.randomState();
    // also random levels in exact mode
    if (exact) st.forEach(sl=>{ sl.li = Math.floor(Math.random()*sl.rec.levels.length); });
    s.recompute(st);
    const v=new Float64Array(12); const tmp=new Float64Array(12);
    st.forEach(sl=>{ s.slotVec(sl,tmp); for(let k=0;k<12;k++) v[k]+=tmp[k]; });
    const m=SV.materialize(P, st);
    const tot=m.result.uncapped; n++;
    const diffs=SV.STATS.map((st,k)=>[st, E.roundTo(v[k],1), tot[st]||0]).filter(([,a,b])=>Math.abs(a-b)>1e-6);
    if (diffs.length || Object.keys(m.warnings).length){ bad++; if(bad<5) console.log(JSON.stringify(diffs), m.warnings, m.code); }
  }
}
console.log(`${n-bad}/${n} random states: fast slot maths == engine, no builder warnings`);
