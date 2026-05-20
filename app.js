const BASE='https://api.chess.com/pub/player';
const charts={};
const DRAW_RESULTS=new Set(['agreed','repetition','stalemate','timevsinsufficient','insufficient','50move']);
const fmtPct=n=>`${(n*100).toFixed(1)}%`;
const daysAgoTs=d=>Math.floor((Date.now()-d*86400000)/1000);
const getFilterStart=f=>f==='24h'?daysAgoTs(1):f==='7d'?daysAgoTs(7):f==='30d'?daysAgoTs(30):f==='90d'?daysAgoTs(90):0;
const parseMoves=pgn=>(pgn||'').replace(/\{[^}]*\}|\([^)]*\)|\[[^\]]*\]|\d+\.(\.\.)?|\$\d+|1-0|0-1|1\/2-1\/2|\*/g,' ').trim().split(/\s+/).filter(Boolean);

const ENGINE_URLS=[
  'https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js',
  'https://unpkg.com/stockfish.js@10.0.2/stockfish.js'
];
const engine={w:null,ready:false,q:[],pending:null,fallback:true,url:null};

function initEngine(){
  if(engine.w||engine.fallback===false) return;
  for(const url of ENGINE_URLS){
    try { engine.w=new Worker(url); engine.url=url; break; } catch {}
  }
  if(!engine.w){ engine.fallback=false; return; }
  engine.w.onmessage=e=>onEngine(String(e.data||''));
  engine.w.onerror=()=>{engine.fallback=false; status.textContent='Engine worker failed; using fast estimate mode.';};
  engine.w.postMessage('uci'); engine.w.postMessage('isready');
}
function onEngine(line){
  if(line==='readyok'){engine.ready=true;runNext();return;}
  if(!engine.pending) return;
  if(line.startsWith('info')&&line.includes(' score ')) engine.pending.last=line;
  if(line.startsWith('bestmove')){engine.pending.resolve(scoreFrom(engine.pending.last)); engine.pending=null; runNext();}
}
function scoreFrom(info){if(!info) return 0;const m=info.match(/score (cp|mate) (-?\d+)/);if(!m)return 0; if(m[1]==='cp') return Math.max(-1000,Math.min(1000,Number(m[2]))); return Number(m[2])>0?1000:-1000;}
function runNext(){if(!engine.ready||engine.pending||!engine.q.length) return;engine.pending=engine.q.shift();engine.w.postMessage(`position fen ${engine.pending.fen}`);engine.w.postMessage(`go depth ${engine.pending.depth||7}`)}
function evalFen(fen,depth=7){initEngine(); if(!engine.w||engine.fallback===false) return Promise.resolve(null); return new Promise(resolve=>{engine.q.push({fen,depth,resolve,last:''});runNext(); setTimeout(()=>resolve(null),3500);});}

async function getJson(u){const r=await fetch(u);if(!r.ok) throw new Error(`HTTP ${r.status}: ${u}`);return r.json();}
async function loadData(user){const idx=await getJson(`${BASE}/${user}/games/archives`);const months=await Promise.all((idx.archives||[]).map(getJson));return months.flatMap(m=>m.games||[]);}
function perspective(g,u){const meWhite=g.white.username?.toLowerCase()===u.toLowerCase(),me=meWhite?g.white:g.black,opp=meWhite?g.black:g.white,res=me.result,outcome=res==='win'?'Win':(DRAW_RESULTS.has(res)?'Draw':'Loss');return {meWhite,me,opp,res,outcome};}
function filterGames(games,user,range,timeClass,limit){const start=getFilterStart(range);return games.filter(g=>g.rated&&g.time_class&&g.end_time>=start&&(timeClass==='all'||g.time_class===timeClass)&&((g.white.username||'').toLowerCase()===user.toLowerCase()||(g.black.username||'').toLowerCase()===user.toLowerCase())).sort((a,b)=>a.end_time-b.end_time).slice(-limit);}

const evalCache=new Map();
function saveCache(){localStorage.setItem('engineEvalCacheV2',JSON.stringify([...evalCache.entries()]));}
function loadCache(){try{const raw=localStorage.getItem('engineEvalCacheV2');if(raw) for(const [k,v] of JSON.parse(raw)) evalCache.set(k,v);}catch{}}
loadCache();

async function evaluateGameQuick(g,user){
  const key=(g.url||'')+':v2'; if(evalCache.has(key)) return evalCache.get(key);
  const {me,opp,res}=perspective(g,user);
  const moves=parseMoves(g.pgn); let myErr=0,oppErr=0,myN=0,oppN=0;
  if(engine.fallback!==false){
    const chess=new Chess();
    let prev=await evalFen(chess.fen(),6);
    const step=Math.max(1,Math.floor(moves.length/24)); // sample to speed
    for(let i=0;i<moves.length;i++){
      if(!chess.move(moves[i],{sloppy:true})) continue;
      if(i%step!==0 && i!==moves.length-1) continue;
      const e=await evalFen(chess.fen(),6);
      if(prev!=null && e!=null){
        const drop=Math.abs(e-prev);
        const whiteMove=i%2===0; const meMoved=(me.color==='white'&&whiteMove)||(me.color==='black'&&!whiteMove);
        if(meMoved){myErr+=drop;myN++;} else {oppErr+=drop;oppN++;}
      }
      if(e!=null) prev=e;
    }
  }
  // fallback heuristic if engine unavailable or sparse
  if(myN===0||oppN===0){
    const base=Math.max(30,140-(moves.length/2));
    myErr=base + (res==='win'?-18:res==='timeout'?18:0); oppErr=base + (res==='win'?18:-10); myN=oppN=1;
  }
  const toElo=err=>Math.max(500,Math.min(2900,2550-err*3.1));
  const out={myEngineElo:toElo(myErr/myN),oppEngineElo:toElo(oppErr/oppN)};
  evalCache.set(key,out); saveCache(); return out;
}

function renderKpis(games){const wins=games.filter(g=>perspective(g,current.user).res==='win').length;const draws=games.filter(g=>DRAW_RESULTS.has(perspective(g,current.user).res)).length;const losses=games.length-wins-draws;kpis.innerHTML=[['Games in view',games.length],['W/D/L',`${wins}/${draws}/${losses}`],['Win rate',games.length?fmtPct(wins/games.length):'n/a'],['Cached evals',evalCache.size]].map(([k,v])=>`<div class='glass card'><div class='k'>${k}</div><div class='v'>${v}</div></div>`).join('');}

function makeLineChart(el,config){return new Chart(el,{...config,options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},plugins:{legend:{position:'top'},...(config.options?.plugins||{})},scales:config.options?.scales||{}}});}
function drawSkillGraph(points){charts.skill?.destroy?.();charts.skill=makeLineChart(ratingChart,{type:'line',data:{labels:points.map(p=>p.label),datasets:[{label:'Your Chess.com Elo',data:points.map(p=>p.myElo),borderColor:'#0071e3'},{label:'Opponent Chess.com Elo',data:points.map(p=>p.oppElo),borderColor:'#8e8e93'},{label:'Your Engine Elo',data:points.map(p=>p.myEng),borderColor:'#1a7f37'},{label:'Opponent Engine Elo',data:points.map(p=>p.oppEng),borderColor:'#b42318'}]},options:{plugins:{title:{display:true,text:'Per-Game Skill Trend'}}}});}
function drawOpponentSpread(points){charts.opp?.destroy?.();charts.opp=new Chart(oppRatingChart,{type:'scatter',data:{datasets:[{label:'Engine edge vs opponent Elo',data:points.filter(p=>p.myEng&&p.oppEng).map(p=>({x:p.oppElo,y:p.myEng-p.oppEng})),backgroundColor:'#0071e3'}]},options:{responsive:true,maintainAspectRatio:false,scales:{x:{title:{display:true,text:'Opponent Chess.com Elo'}},y:{title:{display:true,text:'Engine Elo edge'}}}}});}
function drawVolume(points){charts.vol?.destroy?.();charts.vol=new Chart(volumeChart,{type:'bar',data:{labels:points.map(p=>p.label),datasets:[{label:'Game index',data:points.map((_,i)=>i+1),backgroundColor:'#d6eaff'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},title:{display:true,text:'Games in selection'}}}});}
function drawResults(points){charts.res?.destroy?.();charts.res=new Chart(resultChart,{type:'line',data:{labels:points.map(p=>p.label),datasets:[{label:'Your Engine Elo',data:points.map(p=>p.myEng),borderColor:'#1a7f37'},{label:'Opp Engine Elo',data:points.map(p=>p.oppEng),borderColor:'#b42318'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{title:{display:true,text:'Engine Elo Comparison'}}}});}

function renderFeed(games,points){feedCount.textContent=`${games.length} games`;gamesFeed.innerHTML=games.map((g,i)=>{const p=perspective(g,current.user),e=points[i];const d=new Date(g.end_time*1000).toISOString().slice(0,10);return `<button class='game-row'><span>${d}</span><span>${g.time_class}</span><span>${p.me.username} (${p.me.rating}) vs ${p.opp.username} (${p.opp.rating})</span><span class='${p.outcome.toLowerCase()}'>${p.outcome}</span><span class='tag'>Eng ${e.myEng??'-'}/${e.oppEng??'-'}</span></button>`;}).join('');}
function drawFeedDetails(){advancedKpis.innerHTML=`<div class='glass card'><div class='k'>Engine mode</div><div class='v' style='font-size:18px'>${engine.w?'Stockfish worker active':'Fallback estimate mode'}</div></div>`; gameDetails.innerHTML='<div class="sub">Main chart shows your Chess.com Elo and engine-estimated Elo vs opponent values per game. Use timeframe, game type, and game count filters.</div>';}
function updateProgressive(points, filtered, done, total){renderKpis(filtered);drawSkillGraph(points);drawOpponentSpread(points);drawVolume(points);drawResults(points);drawFeedDetails();renderFeed(filtered.slice(0,points.length),points);status.textContent=done<total?`Engine-evaluating ${done}/${total}...`:`Done. ${total} games plotted.`;}

let runToken=0; const current={user:'',games:[]};
async function run(){const user=username.value.trim();const range=rangeFilter.value;const timeClass=timeClassFilter.value;const limit=Number(gameCountFilter.value)||100;const token=++runToken;status.textContent='Loading...';
 try{if(current.user!==user||!current.games.length){current.user=user;current.games=await loadData(user);}const filtered=filterGames(current.games,user,range,timeClass,limit);const points=filtered.map((g,i)=>{const p=perspective(g,user);return {label:`${new Date(g.end_time*1000).toISOString().slice(0,10)} #${i+1}`,myElo:p.me.rating||null,oppElo:p.opp.rating||null,myEng:null,oppEng:null};});updateProgressive(points,filtered,0,filtered.length);
 for(let i=0;i<filtered.length;i++){if(token!==runToken) return;const eng=await evaluateGameQuick(filtered[i],user);points[i].myEng=Math.round(eng.myEngineElo);points[i].oppEng=Math.round(eng.oppEngineElo);if(i%2===0||i===filtered.length-1) updateProgressive(points,filtered,i+1,filtered.length);} }
 catch(e){status.textContent=`Error: ${e.message}`;}}

loadBtn.addEventListener('click',run);rangeFilter.addEventListener('change',run);timeClassFilter.addEventListener('change',run);gameCountFilter.addEventListener('change',run);run();
