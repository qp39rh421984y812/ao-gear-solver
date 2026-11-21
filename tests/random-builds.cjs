const path=require('path').join(__dirname,'..','public')+'/';
require(path+'js/engine.js'); const E=globalThis.AOEngine; const d=require(path+'data/equipment.json');
const N=+process.argv[2]||40; let seed=+process.argv[3]||1;
const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};
const pick=a=>a[Math.floor(rnd()*a.length)];
const gems=E.allGems(d), magics=E.magicsOf(d), styles=E.stylesOf(d);
const out=[];
while(out.length<N){
  const level=pick([175,175,175,150,133,120,100,64]);
  const pts=level*2; const alloc={Magic:0,Strength:0,Weapons:0,Spirit:0};
  if(rnd()<0.8){ let left=pts; for(const k of E.ALLOC_KEYS){ const v=Math.floor(rnd()*left*(rnd()<0.5?1:0.5)); alloc[k]=v; left-=v; } }
  const keys=E.identityKeys(alloc,d);
  const m1=pick(magics).id, m2=pick(magics.filter(x=>x.id!==m1)).id, s1=pick(styles).id, s2=pick(styles.filter(x=>x.id!==s1)).id;
  if(keys.includes('primaryMagic')) alloc.primaryMagic=m1; if(keys.includes('secondaryMagic')) alloc.secondaryMagic=m2;
  if(keys.includes('primaryFightingStyle')) alloc.primaryFightingStyle=s1; if(keys.includes('secondaryFightingStyle')) alloc.secondaryFightingStyle=s2;
  const ident=E.selectedIdentity(alloc,d);
  const slots={}; const usedAcc=[];
  for(const def of E.SLOTS){
    if(rnd()<0.1){slots[def.id]={item:null,gems:[]};continue;}
    const pool=d.items.filter(it=>def.types.includes(it.equipType)&&level>=(it.minLevel||1)&&!it.isArcaniumTemplate&&!it.isFightingStyleTemplate
      &&(!it.magicId||ident.magic.has(it.magicId))&&(!it.fightingStyleId||ident.style.has(it.fightingStyleId))
      &&!(def.group==='accessory'&&usedAcc.some(u=>E.baseNameOf(u)===E.baseNameOf(it)||(u.subType==='Amulet'&&it.subType==='Amulet')||(u.subType==='Helmet'&&it.subType==='Helmet'))));
    if(!pool.length){slots[def.id]={item:null,gems:[]};continue;}
    // bias toward magic/style/spirit items
    let it=pick(pool); if(rnd()<0.35){const sp=pool.filter(x=>x.magicId||x.fightingStyleId||x.statType==='Spirit'||x.flatStats); if(sp.length) it=pick(sp);}
    if(def.group==='accessory') usedAcc.push(it);
    const lv=E.itemLevels(it,level); const sl={item:it, level: rnd()<0.7?lv[0]:pick(lv), gems:[]};
    const ench=[...d.enchantments,...d.shieldEnchantments].filter(e=>E.enchantAllowed(e,it)); if(rnd()<0.7&&ench.length) sl.enchant=pick(ench);
    const mods=d.modifiers.filter(m=>E.modifierAllowed(m,it)); if(rnd()<0.7&&mods.length) sl.modifier=rnd()<0.3?(mods.find(m=>m.name==='Atlantean')||pick(mods)):pick(mods);
    const fac=d.factionModifiers.filter(m=>E.modifierAllowed(m,it)); if((!sl.modifier||sl.modifier.name==='Atlantean')&&rnd()<0.5&&fac.length) sl.factionModifier=pick(fac);
    const n=E.socketCount(sl);
    for(let g=0;g<n;g++){ if(rnd()<0.15){sl.gems.push(E.emptyJewel());continue;}
      const j={primary:{gem:pick(gems),tier:rnd()<0.7?5:Math.floor(rnd()*6),reagent:null},secondReagent:null,fusion:null};
      if(rnd()<0.4) j.fusion={primary:{gem:rnd()<0.3?j.primary.gem:pick(gems),tier:rnd()<0.7?5:Math.floor(rnd()*6),reagent:null},secondReagent:null};
      sl.gems.push(j);}
    slots[def.id]=sl;
  }
  const w=E.buildWarnings(d,level,alloc,slots); if(Object.keys(w).length) continue;
  const r=E.calcBuild({data:d,level,allocator:alloc,slots});
  out.push({code:E.encodeBuild({data:d,level,allocator:alloc,slots}),totals:r.totals,ep:r.ep,cls:E.classify(alloc,d)});
}
console.log(JSON.stringify(out));
