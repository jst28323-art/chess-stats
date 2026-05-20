const BASE='https://api.chess.com/pub/player';
const charts={};
const DRAW_RESULTS=new Set(['agreed','repetition','stalemate','timevsinsufficient','insufficient','50move']);
const fmtPct=n=>`${(n*100).toFixed(1)}%`;
const daysAgoTs=d=>Math.floor((Date.now()-d*86400000)/1000);
const getFilterStart=f=>f==='24h'?daysAgoTs(1):f==='7d'?daysAgoTs(7):f==='30d'?daysAgoTs(30):f==='90d'?daysAgoTs(90):0;
const parseMoves=pgn=>(pgn||'').replace(/\{[^}]*\}|\([^)]*\)|\[[^\]]*\]|\d+\.(\.\.)?|\$\d+|1-0|0-1|1\/2-1\/2|\*/g,' ').trim().split(/\s+/).filter(Boolean);
const EVAL_DEPTH=10;
const POSITION_TIMEOUT_MS=2500;
const MAX_MOVES_PER_GAME=300;
const MAX_MS_PER_GAME=180000;

const els={
  username:()=>document.getElementById('username'),
  rangeFilter:()=>document.getElementById('rangeFilter'),
  timeClassFilter:()=>document.getElementById('timeClassFilter'),
  gameCountFilter:()=>document.getElementById('gameCountFilter'),
  status:()=>document.getElementById('status'),
  engineDiag:()=>document.getElementById('engineDiag'),
  kpis:()=>document.getElementById('kpis'),
  ratingChart:()=>document.getElementById('ratingChart'),
  oppRatingChart:()=>document.getElementById('oppRatingChart'),
  volumeChart:()=>document.getElementById('volumeChart'),
  resultChart:()=>document.getElementById('resultChart'),
  feedCount:()=>document.getElementById('feedCount'),
  gamesFeed:()=>document.getElementById('gamesFeed'),
  advancedKpis:()=>document.getElementById('advancedKpis'),
  gameDetails:()=>document.getElementById('gameDetails'),
  loadBtn:()=>document.getElementById('loadBtn')
};
function setStatus(msg){ const el=els.status(); if(el) el.textContent=msg; }
function getChessCtor(){
  if(typeof Chess!=='undefined') return Chess;
  if(typeof window!=='undefined' && typeof window.Chess!=='undefined') return window.Chess;
  if(typeof globalThis!=='undefined' && typeof globalThis.Chess!=='undefined') return globalThis.Chess;
  if(typeof window!=='undefined' && window.chess && typeof window.chess.Chess!=='undefined') return window.chess.Chess;
  if(typeof globalThis!=='undefined' && globalThis.chess && typeof globalThis.chess.Chess!=='undefined') return globalThis.chess.Chess;
  return null;
}


const ENGINE_URLS=['./stockfish.js','https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js','https://unpkg.com/stockfish.js@10.0.2/stockfish.js'];
const engine={w:null,ready:false,url:null,readyTimer:null,pending:null,completed:0,timeouts:0,failedReady:0,fallback:false};
function setDiag(msg){const el=els.engineDiag(); if(el) el.textContent=`Engine: ${msg}`;}

function cleanupPendingAsNull(){
  if(engine.pending){
    clearTimeout(engine.pending.timer);
    engine.pending.resolve(null);
    engine.pending=null;
  }
}
function disableEngine(reason){
  engine.fallback=true;
  cleanupPendingAsNull();
  if(engine.readyTimer) clearTimeout(engine.readyTimer);
  engine.ready=false;
  if(engine.w){try{engine.w.terminate();}catch{}}
  engine.w=null;
  setDiag(`fallback (${reason})`);
}
function initEngine(){
  if(engine.w||engine.fallback) return;
  for(const u of ENGINE_URLS){ try{ engine.w=new Worker(u); engine.url=u; break; } catch{} }
  if(!engine.w){ disableEngine('worker create failed'); return; }
  setDiag(`worker loaded (${engine.url.includes('./')?'local':'cdn'})`);
  engine.w.onmessage=e=>onEngineMsg(String(e.data||''));
  engine.w.onerror=()=>disableEngine('worker error');
  engine.readyTimer=setTimeout(()=>{engine.failedReady++; disableEngine('ready timeout');},3000);
  engine.w.postMessage('uci');
  engine.w.postMessage('isready');
}
function onEngineMsg(line){
  line=String(line||'').trim();
  if(line==='readyok' || line.includes('readyok')){
    if(engine.readyTimer) clearTimeout(engine.readyTimer);
    engine.ready=true;
    setDiag('stockfish ready');
    return;
  }
  if(!engine.pending) return;
  if(line.startsWith('info')&&line.includes(' score ')) engine.pending.lastInfo=line;
  if(line.startsWith('bestmove')){
    clearTimeout(engine.pending.timer);
    const p=engine.pending;
    engine.pending=null;
    engine.completed++;
    p.resolve(parseScore(p.lastInfo));
  }
}
function parseScore(info){
  if(!info) return 0;
  const m=info.match(/score (cp|mate) (-?\d+)/);
  if(!m) return 0;
  if(m[1]==='cp') return Math.max(-1000,Math.min(1000,Number(m[2])));
  return Number(m[2])>0?1000:-1000;
}
async function evalFen(fen, depth=EVAL_DEPTH){
  initEngine();
  if(engine.fallback) return null;
  if(!engine.ready){
    const t0=Date.now();
    while(!engine.ready && !engine.fallback && Date.now()-t0<3200) await new Promise(r=>setTimeout(r,40));
  }
  if(engine.fallback||!engine.ready||!engine.w) return null;
  return new Promise(resolve=>{
    engine.pending={resolve,lastInfo:'',timer:setTimeout(()=>{engine.timeouts++; cleanupPendingAsNull();},POSITION_TIMEOUT_MS)};
    engine.w.postMessage(`position fen ${fen}`);
    engine.w.postMessage(`go depth ${depth}`);
  });
}


async function runEngineSelfTest(){
  const startFen='rn1qkbnr/pp3ppp/2pb4/3pp3/8/2N2N2/PPPP1PPP/R1BQKB1R w KQkq - 0 6';
  const v=await evalFen(startFen,EVAL_DEPTH);
  if(v==null){ setDiag('self-test failed (fallback active)'); return false; }
  setDiag(`self-test ok cp=${v}`);
  return true;
}

async function getJson(u){const r=await fetch(u); if(!r.ok) throw new Error(`HTTP ${r.status}: ${u}`); return r.json();}
async function loadData(user){const idx=await getJson(`${BASE}/${user}/games/archives`); const months=await Promise.all((idx.archives||[]).map(getJson)); return months.flatMap(m=>m.games||[]);} 
function perspective(g,u){const meWhite=g.white.username?.toLowerCase()===u.toLowerCase(),me=meWhite?g.white:g.black,opp=meWhite?g.black:g.white,res=me.result,outcome=res==='win'?'Win':(DRAW_RESULTS.has(res)?'Draw':'Loss');return {meWhite,me,opp,res,outcome};}
function filterGames(games,user,range,timeClass,limit){const start=getFilterStart(range);return games.filter(g=>g.rated&&g.time_class&&g.end_time>=start&&(timeClass==='all'||g.time_class===timeClass)&&((g.white.username||'').toLowerCase()===user.toLowerCase()||(g.black.username||'').toLowerCase()===user.toLowerCase())).sort((a,b)=>a.end_time-b.end_time).slice(-limit);} 

const evalCache=new Map();
function saveCache(){localStorage.setItem('engineEvalCacheV4',JSON.stringify([...evalCache.entries()]));}
function loadCache(){try{const raw=localStorage.getItem('engineEvalCacheV4'); if(raw) for(const [k,v] of JSON.parse(raw)) evalCache.set(k,v);}catch{}}
loadCache();

async function evaluateGameMoveByMove(g,user,onProgress){
  const key=(g.url||'')+':moveByMove:v4';
  if(evalCache.has(key)) return evalCache.get(key);
  const {meWhite,res}=perspective(g,user);
  const moves=parseMoves(g.pgn);
  const ChessCtor=getChessCtor();
  if(!ChessCtor){ disableEngine('missing chess.js'); throw new Error('Chess.js failed to load (constructor missing). Check chess.js CDN availability.'); }
  const chess=new ChessCtor();
  const evals=[];
  const tGameStart=Date.now();
  let prev=await evalFen(chess.fen(),EVAL_DEPTH);
  if(prev==null) prev=0;
  evals.push(prev);
  let myErr=0,oppErr=0,myN=0,oppN=0;
  for(let i=0;i<Math.min(moves.length,MAX_MOVES_PER_GAME);i++){
    if(Date.now()-tGameStart>MAX_MS_PER_GAME){ setDiag('per-game time budget reached'); break; }
    if(!chess.move(moves[i],{sloppy:true})) continue;
    if(i%5===0 && onProgress) onProgress(i+1, Math.min(moves.length,MAX_MOVES_PER_GAME));
    if(i%20===0){ setDiag(engine.fallback?`fallback analyzing move ${i+1}`:`analyzing move ${i+1}`); }
    let e=await evalFen(chess.fen(),EVAL_DEPTH);
    if(e==null) e=prev; // continuity for plotting every move
    evals.push(e);
    const delta=Math.abs(e-prev);
    const whiteMove=i%2===0;
    const meMoved=(meWhite&&whiteMove)||(!meWhite&&!whiteMove);
    if(meMoved){myErr+=delta; myN++;} else {oppErr+=delta; oppN++;}
    prev=e;
  }
  if(myN===0||oppN===0){
    const base=Math.max(30,140-(moves.length/2));
    myErr=base + (res==='win'?-18:res==='timeout'?18:0); oppErr=base + (res==='win'?18:-10); myN=oppN=1;
  }
  const toElo=err=>Math.max(500,Math.min(2900,2550-err*3.1));
  const usedFallback = (myN===1 && oppN===1 && evals.length<=2);
  let myEngineElo=toElo(myErr/myN), oppEngineElo=toElo(oppErr/oppN);
  if(usedFallback){
    const jitter=((moves.length%7)-3)*6;
    myEngineElo=Math.max(650,myEngineElo+jitter);
    oppEngineElo=Math.max(650,oppEngineElo-jitter);
  }
  const out={myEngineElo,oppEngineElo,evals,movesCount:moves.length,usedFallback};
  evalCache.set(key,out); saveCache();
  return out;
}

function renderKpis(games){const wins=games.filter(g=>perspective(g,current.user).res==='win').length;const draws=games.filter(g=>DRAW_RESULTS.has(perspective(g,current.user).res)).length;const losses=games.length-wins-draws;els.kpis().innerHTML=[['Games in view',games.length],['W/D/L',`${wins}/${draws}/${losses}`],['Win rate',games.length?fmtPct(wins/games.length):'n/a'],['Cached evals',evalCache.size]].map(([k,v])=>`<div class='glass card'><div class='k'>${k}</div><div class='v'>${v}</div></div>`).join('');}
function makeLineChart(el,config){return new Chart(el,{...config,options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},plugins:{legend:{position:'top'},...(config.options?.plugins||{})},scales:config.options?.scales||{}}});}
function drawSkillGraph(points){charts.skill?.destroy?.();charts.skill=makeLineChart(ratingChart,{type:'line',data:{labels:points.map(p=>p.label),datasets:[{label:'Your Chess.com Elo',data:points.map(p=>p.myElo),borderColor:'#0071e3'},{label:'Opponent Chess.com Elo',data:points.map(p=>p.oppElo),borderColor:'#8e8e93'},{label:'Your Engine Elo',data:points.map(p=>p.myEng),borderColor:'#1a7f37'},{label:'Opponent Engine Elo',data:points.map(p=>p.oppEng),borderColor:'#b42318'}]},options:{plugins:{title:{display:true,text:'Per-Game Skill Trend'}}}});} 
function drawOpponentSpread(points){charts.opp?.destroy?.();charts.opp=new Chart(els.oppRatingChart(),{type:'scatter',data:{datasets:[{label:'Engine edge vs opponent Elo',data:points.filter(p=>p.myEng&&p.oppEng).map(p=>({x:p.oppElo,y:p.myEng-p.oppEng})),backgroundColor:'#0071e3'}]},options:{responsive:true,maintainAspectRatio:false,scales:{x:{title:{display:true,text:'Opponent Chess.com Elo'}},y:{title:{display:true,text:'Engine Elo edge'}}}}});}
function drawVolume(points){charts.vol?.destroy?.();charts.vol=new Chart(els.volumeChart(),{type:'bar',data:{labels:points.map(p=>p.label),datasets:[{label:'Game index',data:points.map((_,i)=>i+1),backgroundColor:'#d6eaff'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},title:{display:true,text:'Games in selection'}}}});} 
function drawResults(points){charts.res?.destroy?.();charts.res=new Chart(els.resultChart(),{type:'line',data:{labels:points.map(p=>p.label),datasets:[{label:'Your Engine Elo',data:points.map(p=>p.myEng),borderColor:'#1a7f37'},{label:'Opp Engine Elo',data:points.map(p=>p.oppEng),borderColor:'#b42318'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{title:{display:true,text:'Engine Elo Comparison'}}}});} 
function renderFeed(games,points){els.feedCount().textContent=`${games.length} games`;els.gamesFeed().innerHTML=games.map((g,i)=>{const p=perspective(g,current.user),e=points[i];const d=new Date(g.end_time*1000).toISOString().slice(0,10);return `<button class='game-row' data-idx='${i}'><span>${d}</span><span>${g.time_class}</span><span>${p.me.username} (${p.me.rating}) vs ${p.opp.username} (${p.opp.rating})</span><span class='${p.outcome.toLowerCase()}'>${p.outcome}</span><span class='tag'>Eng ${e.myEng??'-'}/${e.oppEng??'-'}${e.usedFallback?'*':''}</span></button>`;}).join('');}
function drawFeedDetails(filtered,pointMap){els.advancedKpis().innerHTML=`<div class='glass card'><div class='k'>Engine mode</div><div class='v' style='font-size:18px'>${engine.fallback?'Fallback estimate mode':(engine.ready?'Stockfish worker active':'Stockfish warming up')}</div></div>`;
  els.gameDetails().innerHTML='<div class="sub">Click a game row to open move-by-move eval chart.</div>';
  document.querySelectorAll('.game-row').forEach(btn=>btn.addEventListener('click',()=>{
    const i=Number(btn.dataset.idx); const p=pointMap[i];
    if(!p || !p.evals){ els.gameDetails().innerHTML='<div class="sub">No move-by-move eval available yet for this game.</div>'; return; }
    els.gameDetails().innerHTML='<div class="chart-card" style="height:300px"><canvas id="gameEvalChart"></canvas></div><div class="sub">Move-by-move eval (cp, White+)</div>';
    charts.gameEval?.destroy?.();
    charts.gameEval=new Chart(document.getElementById('gameEvalChart'),{type:'line',data:{labels:p.evals.map((_,ix)=>ix),datasets:[{label:'Eval cp',data:p.evals,borderColor:'#0071e3'}]},options:{responsive:true,maintainAspectRatio:false}});
  }));
}
function updateProgressive(points, filtered, done, total){renderKpis(filtered);drawSkillGraph(points);drawOpponentSpread(points);drawVolume(points);drawResults(points);renderFeed(filtered,points);drawFeedDetails(filtered,points);setStatus(done<total?`Engine-evaluating ${done}/${total}...`:`Done. ${total} games plotted.`);const fallbackCount=points.filter(p=>p.usedFallback).length;
setDiag(engine.fallback?`fallback • done ${done}/${total} • fallback games ${fallbackCount}`:`ready • done ${done}/${total} • completed ${engine.completed} • timeouts ${engine.timeouts} • fallback games ${fallbackCount}`);} 

let runToken=0; const current={user:'',games:[]}; let selfTested=false;
async function run(){const user=els.username().value.trim();const range=els.rangeFilter().value;const timeClass=els.timeClassFilter().value;const limit=Number(els.gameCountFilter().value)||100;const token=++runToken;setStatus('Loading...');
  try{
    if(!selfTested){ selfTested=true; await runEngineSelfTest(); setStatus('Engine self-test complete. Starting game evaluations...'); }
    if(current.user!==user||!current.games.length){current.user=user;current.games=await loadData(user);} 
    const filtered=filterGames(current.games,user,range,timeClass,limit);
    const points=filtered.map((g,i)=>{const p=perspective(g,user);return {label:`${new Date(g.end_time*1000).toISOString().slice(0,10)} #${i+1}`,myElo:p.me.rating||null,oppElo:p.opp.rating||null,myEng:null,oppEng:null,evals:null,usedFallback:false};});
    updateProgressive(points,filtered,0,filtered.length);
    for(let i=0;i<filtered.length;i++){
      if(token!==runToken) return;
      setStatus(`Evaluating game ${i+1}/${filtered.length}...`);
      const eng=await evaluateGameMoveByMove(filtered[i],user,(mv,totalMv)=>{setStatus(`Evaluating game ${i+1}/${filtered.length} • move ${mv}/${totalMv}`);});
      points[i].myEng=Math.round(eng.myEngineElo);
      points[i].oppEng=Math.round(eng.oppEngineElo);
      points[i].evals=eng.evals;
      points[i].usedFallback=!!eng.usedFallback;
      updateProgressive(points,filtered,i+1,filtered.length);
    }
  } catch(e){setStatus(`Error: ${e.message}`); console.error(e);}
}

els.loadBtn().addEventListener('click',run);els.rangeFilter().addEventListener('change',run);els.timeClassFilter().addEventListener('change',run);els.gameCountFilter().addEventListener('change',run);run();
