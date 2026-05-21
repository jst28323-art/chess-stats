const BASE='https://api.chess.com/pub/player';
const DEFAULT_BACKEND_URL='http://localhost:8787';
const BACKEND={
  url:(localStorage.getItem('backendUrl')||'').replace(/\/+$/,''),  // empty = discover via tunnel.json
  urlSource:'localStorage', // 'localStorage' | 'tunnel.json' | 'default'
  healthy:false,        // probed and stockfish available
  online:false,         // probed and responding (even if stockfish missing)
  info:null,
  byUrl:new Map(),      // game_url -> backend game record (includes evals[], elos, game_id)
  detailCache:new Map(),// game_url -> per-ply rows (from /api/game/{id}/analysis)
  jobId:null,
  jobStatus:null,
};
async function discoverBackendUrl(){
  // Resolution order:
  //  1. localStorage 'backendUrl' (user-set, sticky)
  //  2. ./tunnel.json from same origin (auto-published by scripts/launch_tunnel.py)
  //  3. DEFAULT_BACKEND_URL (localhost — only useful when frontend is on same PC)
  if(BACKEND.url){ BACKEND.urlSource='localStorage'; return BACKEND.url; }
  try{
    const r=await fetch('./tunnel.json?ts='+Date.now(),{cache:'no-store'});
    if(r.ok){
      const j=await r.json();
      if(j && j.backendUrl){
        BACKEND.url = String(j.backendUrl).replace(/\/+$/,'');
        BACKEND.urlSource='tunnel.json';
        return BACKEND.url;
      }
    }
  }catch{}
  BACKEND.url=DEFAULT_BACKEND_URL;
  BACKEND.urlSource='default';
  return BACKEND.url;
}
const charts={};
const DRAW_RESULTS=new Set(['agreed','repetition','stalemate','timevsinsufficient','insufficient','50move']);
const fmtPct=n=>`${(n*100).toFixed(1)}%`;
const daysAgoTs=d=>Math.floor((Date.now()-d*86400000)/1000);
const getFilterStart=f=>f==='24h'?daysAgoTs(1):f==='7d'?daysAgoTs(7):f==='30d'?daysAgoTs(30):f==='90d'?daysAgoTs(90):0;
const parseMoves=pgn=>(pgn||'').replace(/\{[^}]*\}|\([^)]*\)|\[[^\]]*\]|\d+\.(\.\.)?|\$\d+|1-0|0-1|1\/2-1\/2|\*/g,' ').trim().split(/\s+/).filter(Boolean);
const EVAL_DEPTH=8;
const POSITION_TIMEOUT_MS=4000;
const ENGINE_MOVE_MS=180;
const MAX_MOVES_PER_GAME=300;
const MAX_MS_PER_GAME=900000;

const PIECE_UNICODE={P:'♙',N:'♘',B:'♗',R:'♖',Q:'♕',K:'♔',p:'♟',n:'♞',b:'♝',r:'♜',q:'♛',k:'♚'};
function renderFenBoard(fen){
  const board=fen.split(' ')[0].split('/');
  let html='<div style="display:grid;grid-template-columns:repeat(8,42px);gap:0;border:1px solid #ccc;width:max-content">';
  for(let r=0;r<8;r++){
    let file=0;
    for(const ch of board[r]){
      if(/\d/.test(ch)){ for(let k=0;k<Number(ch);k++){ const dark=(r+file)%2===1; html+=`<div style="width:42px;height:42px;display:flex;align-items:center;justify-content:center;background:${dark?'#769656':'#eeeed2'}"></div>`; file++; } }
      else { const dark=(r+file)%2===1; html+=`<div style="width:42px;height:42px;display:flex;align-items:center;justify-content:center;font-size:28px;background:${dark?'#769656':'#eeeed2'}">${PIECE_UNICODE[ch]||''}</div>`; file++; }
    }
  }
  html+='</div>'; return html;
}

const ENGINE_PROFILE=`d${EVAL_DEPTH}_mt${ENGINE_MOVE_MS}_pt${POSITION_TIMEOUT_MS}_mm${MAX_MOVES_PER_GAME}_mg${MAX_MS_PER_GAME}_v2`;

const els={
  username:()=>document.getElementById('username'),
  rangeFilter:()=>document.getElementById('rangeFilter'),
  timeClassFilter:()=>document.getElementById('timeClassFilter'),
  gameCountFilter:()=>document.getElementById('gameCountFilter'),
  status:()=>document.getElementById('status'),
  engineDiag:()=>document.getElementById('engineDiag'),
  backendUrl:()=>document.getElementById('backendUrl'),
  backendStatus:()=>document.getElementById('backendStatus'),
  backendJob:()=>document.getElementById('backendJob'),
  backendConnectBtn:()=>document.getElementById('backendConnectBtn'),
  preferBackend:()=>document.getElementById('preferBackend'),
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
function setBackendChip(msg, kind){
  const el=els.backendStatus(); if(!el) return;
  el.textContent=msg;
  el.style.color = kind==='good'?'var(--good)':kind==='bad'?'var(--bad)':kind==='warn'?'var(--warn)':'var(--muted)';
}
function setBackendJobChip(msg){ const el=els.backendJob(); if(el) el.textContent=msg||''; }

async function probeBackend(){
  const base=BACKEND.url;
  if(!base){ BACKEND.online=false; BACKEND.healthy=false; setBackendChip('Backend: not configured','warn'); return null; }
  try{
    const r=await fetch(base+'/health',{mode:'cors'});
    if(!r.ok) throw new Error('HTTP '+r.status);
    const info=await r.json();
    BACKEND.info=info; BACKEND.online=true;
    BACKEND.healthy=!!info?.stockfish?.available;
    const srcTag = BACKEND.urlSource==='tunnel.json'?' • via tunnel.json':BACKEND.urlSource==='localStorage'?' • user-set':'';
    if(BACKEND.healthy){ setBackendChip(`Backend: online • ${info.engine_profile}${srcTag}`,'good'); }
    else { setBackendChip(`Backend: online but stockfish missing${srcTag}`,'warn'); }
    return info;
  }catch(e){
    BACKEND.online=false; BACKEND.healthy=false; BACKEND.info=null;
    setBackendChip(`Backend: offline (${e.message})`,'bad');
    return null;
  }
}

async function startBackendJob(user,range,timeClass,limit){
  const r=await fetch(`${BACKEND.url}/api/analyze/player/${encodeURIComponent(user)}`,{
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({range,timeClass,limit,forceRecompute:false}),
  });
  if(!r.ok) throw new Error('job POST HTTP '+r.status);
  const data=await r.json(); BACKEND.jobId=data.job_id; return data.job_id;
}
async function fetchBackendJob(jobId){
  const r=await fetch(`${BACKEND.url}/api/jobs/${jobId}`);
  if(!r.ok) throw new Error('job GET HTTP '+r.status);
  return r.json();
}
async function fetchBackendGames(user,range,timeClass,limit){
  const q=new URLSearchParams({range,timeClass,limit:String(limit)});
  const r=await fetch(`${BACKEND.url}/api/player/${encodeURIComponent(user)}/games?${q}`);
  if(!r.ok) throw new Error('games HTTP '+r.status);
  const data=await r.json();
  BACKEND.byUrl.clear();
  for(const g of (data.games||[])) BACKEND.byUrl.set(g.game_url, g);
  return data;
}
async function fetchBackendGameAnalysis(gameUrl){
  if(BACKEND.detailCache.has(gameUrl)) return BACKEND.detailCache.get(gameUrl);
  const rec=BACKEND.byUrl.get(gameUrl);
  if(!rec || !rec.game_id) return null;
  try{
    const r=await fetch(`${BACKEND.url}/api/game/${rec.game_id}/analysis`);
    if(!r.ok) return null;
    const a=await r.json();
    BACKEND.detailCache.set(gameUrl,a);
    return a;
  }catch{ return null; }
}
function backendGameToChesscomShape(g){
  return {
    url: g.game_url,
    end_time: g.end_time,
    time_class: g.time_class,
    rated: true,
    white: g.white || {username:g.me_white?g.me_user:g.opp_user, rating:g.me_white?g.me_rating:g.opp_rating, result:g.me_white?g.result:undefined},
    black: g.black || {username:g.me_white?g.opp_user:g.me_user, rating:g.me_white?g.opp_rating:g.me_rating, result:g.me_white?undefined:g.result},
    pgn: null,
  };
}
function getChessCtor(){
  if(typeof Chess!=='undefined') return Chess;
  if(typeof window!=='undefined' && typeof window.Chess!=='undefined') return window.Chess;
  if(typeof globalThis!=='undefined' && typeof globalThis.Chess!=='undefined') return globalThis.Chess;
  if(typeof window!=='undefined' && window.chess && typeof window.chess.Chess!=='undefined') return window.chess.Chess;
  if(typeof globalThis!=='undefined' && globalThis.chess && typeof globalThis.chess.Chess!=='undefined') return globalThis.chess.Chess;
  return null;
}


const ENGINE_URLS=['./stockfish.js','https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js','https://unpkg.com/stockfish.js@10.0.2/stockfish.js'];
const engine={w:null,ready:false,url:null,readyTimer:null,pending:null,queue:[],completed:0,timeouts:0,failedReady:0,fallback:false};
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
  while(engine.queue.length){ const q=engine.queue.shift(); try{q.resolve(null);}catch{} }
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
    dispatchNextEngineRequest();
    return;
  }
  if(!engine.pending) return;
  if(line.startsWith('info')&&line.includes(' score ')){ engine.pending.lastInfo=line; const pv=line.match(/\spv\s(.+)$/); if(pv) engine.pending.lastPv=pv[1]; }
  if(line.startsWith('bestmove')){
    clearTimeout(engine.pending.timer);
    const p=engine.pending;
    engine.pending=null;
    engine.completed++;
    const best=(line.split(' ')[1]||'').trim();
    p.resolve({score:parseScore(p.lastInfo),bestmove:best,pv:(p.lastPv||'')});
    dispatchNextEngineRequest();
  }
}
function parseScore(info){
  if(!info) return 0;
  const m=info.match(/score (cp|mate) (-?\d+)/);
  if(!m) return 0;
  if(m[1]==='cp') return Math.max(-1000,Math.min(1000,Number(m[2])));
  return Number(m[2])>0?1000:-1000;
}

function dispatchNextEngineRequest(){
  if(engine.fallback || !engine.ready || !engine.w || engine.pending || !engine.queue.length) return;
  const req=engine.queue.shift();
  engine.pending={...req,lastInfo:'',lastPv:'',timer:setTimeout(()=>{engine.timeouts++; try{engine.w&&engine.w.postMessage('stop');}catch{} cleanupPendingAsNull(); dispatchNextEngineRequest();},POSITION_TIMEOUT_MS)};
  engine.w.postMessage(`position fen ${req.fen}`);
  engine.w.postMessage(`go movetime ${req.movetime||ENGINE_MOVE_MS}`);
}

async function evalFen(fen, depth=EVAL_DEPTH){
  initEngine();
  if(engine.fallback) return null;
  if(!engine.ready){
    const t0=Date.now();
    while(!engine.ready && !engine.fallback && Date.now()-t0<8000) await new Promise(r=>setTimeout(r,40));
  }
  if(engine.fallback||!engine.w) return null;
  return new Promise(resolve=>{
    engine.queue.push({fen,depth,movetime:ENGINE_MOVE_MS,resolve});
    dispatchNextEngineRequest();
  });
}


async function runEngineSelfTest(){
  const startFen='rn1qkbnr/pp3ppp/2pb4/3pp3/8/2N2N2/PPPP1PPP/R1BQKB1R w KQkq - 0 6';
  const v=await evalFen(startFen,EVAL_DEPTH);
  if(v==null){ setDiag('self-test failed (fallback active)'); return false; }
  setDiag(`self-test ok cp=${v}`);
  return true;
}

async function evalFenWithRetry(fen, depth=EVAL_DEPTH){
  let v=await evalFen(fen,depth);
  if(v==null){ v=await evalFen(fen,depth); }
  return v;
}

async function getJson(u){const r=await fetch(u); if(!r.ok) throw new Error(`HTTP ${r.status}: ${u}`); return r.json();}
async function loadData(user){const idx=await getJson(`${BASE}/${user}/games/archives`); const months=await Promise.all((idx.archives||[]).map(getJson)); return months.flatMap(m=>m.games||[]);} 
function perspective(g,u){const meWhite=g.white.username?.toLowerCase()===u.toLowerCase(),me=meWhite?g.white:g.black,opp=meWhite?g.black:g.white,res=me.result,outcome=res==='win'?'Win':(DRAW_RESULTS.has(res)?'Draw':'Loss');return {meWhite,me,opp,res,outcome};}
function filterGames(games,user,range,timeClass,limit){const start=getFilterStart(range);return games.filter(g=>g.rated&&g.time_class&&g.end_time>=start&&(timeClass==='all'||g.time_class===timeClass)&&((g.white.username||'').toLowerCase()===user.toLowerCase()||(g.black.username||'').toLowerCase()===user.toLowerCase())).sort((a,b)=>a.end_time-b.end_time).slice(-limit);} 

const evalCache=new Map();
function saveCache(){localStorage.setItem('engineEvalCacheV6',JSON.stringify([...evalCache.entries()]));}
function loadCache(){try{const raw=localStorage.getItem('engineEvalCacheV6'); if(raw) for(const [k,v] of JSON.parse(raw)) evalCache.set(k,v);}catch{}}
loadCache();

async function evaluateGameMoveByMove(g,user,onProgress){
  // Backend-first: if backend ran this game's analysis, use it verbatim.
  const beRec = BACKEND.healthy && g && g.url ? BACKEND.byUrl.get(g.url) : null;
  if(beRec && beRec.has_analysis && Array.isArray(beRec.evals) && beRec.evals.length){
    return {
      myEngineElo: beRec.my_engine_elo,
      oppEngineElo: beRec.opp_engine_elo,
      evals: beRec.evals,
      movesCount: beRec.moves_count||0,
      usedFallback: !!beRec.used_fallback,
      nullEvals: beRec.null_evals||0,
      engineEvals: beRec.engine_evals||0,
      source: 'backend',
    };
  }
  const key=(g.url||'')+`:moveByMove:${ENGINE_PROFILE}:v6`;
  if(evalCache.has(key)) return evalCache.get(key);
  const {meWhite,res}=perspective(g,user);
  const moves=parseMoves(g.pgn);
  const ChessCtor=getChessCtor();
  if(!ChessCtor){ disableEngine('missing chess.js'); throw new Error('Chess.js failed to load (constructor missing). Check chess.js CDN availability.'); }
  const chess=new ChessCtor();
  const evals=[];
  const tGameStart=Date.now();
  let prevObj=await evalFenWithRetry(chess.fen(),EVAL_DEPTH);
  let prev=(prevObj&&typeof prevObj.score==='number')?prevObj.score:0;
  evals.push(prev);
  let myErr=0,oppErr=0,myN=0,oppN=0,nullEvals=0,engineEvals=0;
  for(let i=0;i<Math.min(moves.length,MAX_MOVES_PER_GAME);i++){
    if(Date.now()-tGameStart>MAX_MS_PER_GAME){ setDiag('per-game time budget reached'); break; }
    if(!chess.move(moves[i],{sloppy:true})) continue;
    if(i%5===0 && onProgress) onProgress(i+1, Math.min(moves.length,MAX_MOVES_PER_GAME));
    if(i%20===0){ setDiag(engine.fallback?`fallback analyzing move ${i+1}`:`analyzing move ${i+1}`); }
    let eObj=await evalFenWithRetry(chess.fen(),EVAL_DEPTH);
    let e=(eObj&&typeof eObj.score==='number')?eObj.score:null;
    if(e==null){ nullEvals++; e=prev; } else { engineEvals++; } // continuity for plotting every move
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
  let lowConfidence = engineEvals < Math.max(2, Math.floor((myN+oppN)*0.08));
  if(lowConfidence && !engine.fallback){
    // second pass on sparse positions for better confidence
    const chess2=new ChessCtor();
    let prev2Obj=await evalFenWithRetry(chess2.fen(),EVAL_DEPTH);
    let prev2=(prev2Obj&&typeof prev2Obj.score==='number')?prev2Obj.score:prev;
    let addEngine=0;
    for(let i=0;i<Math.min(moves.length,MAX_MOVES_PER_GAME);i+=2){
      if(!chess2.move(moves[i],{sloppy:true})) continue;
      let e2Obj=await evalFenWithRetry(chess2.fen(),EVAL_DEPTH);
      let e2=(e2Obj&&typeof e2Obj.score==='number')?e2Obj.score:null;
      if(e2!=null){ addEngine++; prev2=e2; }
    }
    engineEvals += addEngine;
    lowConfidence = engineEvals < Math.max(3, Math.floor((myN+oppN)*0.15));
  }
  let myEngineElo=toElo(myErr/myN), oppEngineElo=toElo(oppErr/oppN);
  const usedFallback = (myN===1 && oppN===1 && evals.length<=2) || lowConfidence || (engineEvals===0) || (myEngineElo===500 && oppEngineElo===500);
  if(usedFallback){
    const jitter=((moves.length%7)-3)*6;
    myEngineElo=Math.max(650,myEngineElo+jitter);
    oppEngineElo=Math.max(650,oppEngineElo-jitter);
  }
  const out={myEngineElo,oppEngineElo,evals,movesCount:moves.length,usedFallback,nullEvals,engineEvals};
  evalCache.set(key,out); saveCache();
  return out;
}

function renderKpis(games){const wins=games.filter(g=>perspective(g,current.user).res==='win').length;const draws=games.filter(g=>DRAW_RESULTS.has(perspective(g,current.user).res)).length;const losses=games.length-wins-draws;els.kpis().innerHTML=[['Games in view',games.length],['W/D/L',`${wins}/${draws}/${losses}`],['Win rate',games.length?fmtPct(wins/games.length):'n/a'],['Cached evals',evalCache.size]].map(([k,v])=>`<div class='glass card'><div class='k'>${k}</div><div class='v'>${v}</div></div>`).join('');}
function makeLineChart(el,config){return new Chart(el,{...config,options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},plugins:{legend:{position:'top'},...(config.options?.plugins||{})},scales:config.options?.scales||{}}});}
function drawSkillGraph(points){charts.skill?.destroy?.();charts.skill=makeLineChart(els.ratingChart(),{type:'line',data:{labels:points.map(p=>p.label),datasets:[{label:'Your Chess.com Elo',data:points.map(p=>p.myElo),borderColor:'#0071e3',yAxisID:'yChess'},{label:'Opponent Chess.com Elo',data:points.map(p=>p.oppElo),borderColor:'#8e8e93',yAxisID:'yChess'},{label:'Your Engine Elo',data:points.map(p=>p.myEng),borderColor:'#1a7f37',yAxisID:'yEngine'},{label:'Opponent Engine Elo',data:points.map(p=>p.oppEng),borderColor:'#b42318',yAxisID:'yEngine'}]},options:{plugins:{title:{display:true,text:'Per-Game Skill Trend (Dual Axis)'}},scales:{yChess:{type:'linear',position:'left',title:{display:true,text:'Chess.com Elo'}},yEngine:{type:'linear',position:'right',grid:{drawOnChartArea:false},title:{display:true,text:'Engine Elo'}}}}});} 
function drawOpponentSpread(points){charts.opp?.destroy?.();charts.opp=new Chart(els.oppRatingChart(),{type:'scatter',data:{datasets:[{label:'Engine edge vs opponent Elo',data:points.filter(p=>p.myEng&&p.oppEng).map(p=>({x:p.oppElo,y:p.myEng-p.oppEng})),backgroundColor:'#0071e3'}]},options:{responsive:true,maintainAspectRatio:false,scales:{x:{title:{display:true,text:'Opponent Chess.com Elo'}},y:{title:{display:true,text:'Engine Elo edge'}}}}});}
function drawVolume(points){charts.vol?.destroy?.();charts.vol=new Chart(els.volumeChart(),{type:'bar',data:{labels:points.map(p=>p.label),datasets:[{label:'Game index',data:points.map((_,i)=>i+1),backgroundColor:'#d6eaff'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},title:{display:true,text:'Games in selection'}}}});} 
function drawResults(points){charts.res?.destroy?.();charts.res=new Chart(els.resultChart(),{type:'line',data:{labels:points.map(p=>p.label),datasets:[{label:'Your Engine Elo',data:points.map(p=>p.myEng),borderColor:'#1a7f37'},{label:'Opp Engine Elo',data:points.map(p=>p.oppEng),borderColor:'#b42318'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{title:{display:true,text:'Engine Elo Comparison'}}}});} 
function renderFeed(games,points){els.feedCount().textContent=`${games.length} games`;els.gamesFeed().innerHTML=games.map((g,i)=>{const p=perspective(g,current.user),e=points[i];const d=new Date(g.end_time*1000).toISOString().slice(0,10);const src=e.source==='backend'?'B':(e.source==='local'?'L':'·');return `<button class='game-row' data-idx='${i}'><span>${d}</span><span>${g.time_class}</span><span>${p.me.username} (${p.me.rating}) vs ${p.opp.username} (${p.opp.rating})</span><span class='${p.outcome.toLowerCase()}'>${p.outcome}</span><span class='tag'>${src} Eng ${e.myEng??'-'}/${e.oppEng??'-'}${e.usedFallback?'*':''}</span></button>`;}).join('');}

async function analyzeGameDetailed(g,user){
  if(BACKEND.healthy && g && g.url && BACKEND.byUrl.has(g.url)){
    const a=await fetchBackendGameAnalysis(g.url);
    if(a && Array.isArray(a.plies) && a.plies.length){
      return a.plies.map(p=>({ply:p.ply,move:p.move,eval:p.eval,best:p.best||'-',pv:p.pv||'',fen:p.fen,capture:p.capture}));
    }
  }
  const ChessCtor=getChessCtor();
  if(!ChessCtor) return [];
  const moves=parseMoves(g.pgn);
  const chess=new ChessCtor();
  const rows=[];
  for(let i=0;i<Math.min(moves.length,120);i++){
    if(!chess.move(moves[i],{sloppy:true})) continue;
    const obj=await evalFenWithRetry(chess.fen(),Math.max(8,EVAL_DEPTH));
    rows.push({ply:i+1,move:moves[i],eval:obj&&typeof obj.score==='number'?obj.score:null,best:obj&&obj.bestmove?obj.bestmove:'-',pv:obj&&obj.pv?obj.pv:''});
  }
  return rows;
}

function drawFeedDetails(filtered,pointMap){const done=pointMap.filter(p=>p.myEng!==null&&p.oppEng!==null).length;const fallbackCount=pointMap.filter(p=>p.usedFallback).length;const avgEdge=(pointMap.filter(p=>p.myEng&&p.oppEng).reduce((a,p)=>a+(p.myEng-p.oppEng),0)/(Math.max(1,pointMap.filter(p=>p.myEng&&p.oppEng).length))).toFixed(1);const totalNull=pointMap.reduce((a,p)=>a+(p.nullEvals||0),0);const totalEng=pointMap.reduce((a,p)=>a+(p.engineEvals||0),0);els.advancedKpis().innerHTML=`<div class='glass card'><div class='k'>Engine mode</div><div class='v' style='font-size:18px'>${engine.fallback?'Fallback estimate mode':(engine.ready?'Stockfish worker active':'Stockfish warming up')}</div></div><div class='glass card'><div class='k'>Games Evaluated</div><div class='v'>${done}/${pointMap.length}</div></div><div class='glass card'><div class='k'>Fallback Games</div><div class='v'>${fallbackCount}</div></div><div class='glass card'><div class='k'>Avg Engine Edge</div><div class='v'>${avgEdge}</div></div><div class='glass card'><div class='k'>Engine / Null Positions</div><div class='v'>${totalEng}/${totalNull}</div></div><div class='glass card'><div class='k'>Worker Timeouts</div><div class='v'>${engine.timeouts}</div></div><div class='glass card'><div class='k'>Engine Queue</div><div class='v'>${engine.queue.length}</div></div>`;
  els.gameDetails().innerHTML='<div class="sub">Click a game row to open move-by-move eval chart.</div>';
  document.querySelectorAll('.game-row').forEach(btn=>btn.addEventListener('click',async()=>{
    const i=Number(btn.dataset.idx); const p=pointMap[i];
    if(!p || !p.evals){ els.gameDetails().innerHTML='<div class="sub">No move-by-move eval available yet for this game.</div>'; return; }
    els.gameDetails().innerHTML='<div id="boardWrap"></div><div class="toolbar"><button id="prevPly">Prev</button><button id="nextPly">Next</button><span id="plyMeta" class="sub"></span></div><div id="plyInfo" class="sub">Loading detailed line analysis...</div><div class="chart-card" style="height:220px"><canvas id="gameEvalChart"></canvas></div>';
    charts.gameEval?.destroy?.();
    charts.gameEval=new Chart(document.getElementById('gameEvalChart'),{type:'line',data:{labels:p.evals.map((_,ix)=>ix),datasets:[{label:'Eval cp',data:p.evals,borderColor:'#0071e3'}]},options:{responsive:true,maintainAspectRatio:false}});
    const rows=await analyzeGameDetailed(filtered[i],current.user);
    const ChessCtor=getChessCtor(); const chess=new ChessCtor(); const moves=parseMoves(filtered[i].pgn);
    const fens=[chess.fen()]; const caps=[null];
    for(const m of moves){ const mv=chess.move(m,{sloppy:true}); if(!mv) continue; fens.push(chess.fen()); caps.push(mv.captured?mv.captured:null); }
    let idx=0;
    const render=()=>{ 
      const fen=fens[Math.min(idx,fens.length-1)];
      document.getElementById('boardWrap').innerHTML=renderFenBoard(fen);
      const r=rows[Math.min(idx,Math.max(0,rows.length-1))]||{};
      const cap=caps[Math.min(idx,caps.length-1)];
      document.getElementById('plyMeta').textContent=`Ply ${idx}/${fens.length-1}`;
      document.getElementById('plyInfo').innerHTML=`Played: <b>${r.move||'-'}</b> | Eval: <b>${r.eval??'n/a'}</b> | Best: <b>${r.best||'-'}</b> | Captured: <b>${cap||'none'}</b><br/>PV: ${r.pv||'-'}`;
    };
    document.getElementById('prevPly').onclick=()=>{ idx=Math.max(0,idx-1); render(); };
    document.getElementById('nextPly').onclick=()=>{ idx=Math.min(fens.length-1,idx+1); render(); };
    render();
  }));
}
function updateProgressive(points, filtered, done, total){renderKpis(filtered);drawSkillGraph(points);drawOpponentSpread(points);drawVolume(points);drawResults(points);renderFeed(filtered,points);drawFeedDetails(filtered,points);setStatus(done<total?`Engine-evaluating ${done}/${total}...`:`Done. ${total} games plotted.`);const fallbackCount=points.filter(p=>p.usedFallback).length;
setDiag(engine.fallback?`fallback • done ${done}/${total} • fallback games ${fallbackCount}`:`ready • done ${done}/${total} • completed ${engine.completed} • timeouts ${engine.timeouts} • fallback games ${fallbackCount}`);} 

let runToken=0; const current={user:'',games:[]}; let selfTested=false;

function pointsFromGames(filtered,user){
  return filtered.map((g,i)=>{
    const p=perspective(g,user);
    return {label:`${new Date(g.end_time*1000).toISOString().slice(0,10)} #${i+1}`,
            myElo:p.me.rating||null, oppElo:p.opp.rating||null,
            myEng:null, oppEng:null, evals:null,
            usedFallback:false, nullEvals:0, engineEvals:0, source:null};
  });
}
function applyBackendRowToPoint(point, beRec){
  if(!beRec) return;
  point.myEng = beRec.my_engine_elo!=null?Math.round(beRec.my_engine_elo):point.myEng;
  point.oppEng = beRec.opp_engine_elo!=null?Math.round(beRec.opp_engine_elo):point.oppEng;
  if(Array.isArray(beRec.evals) && beRec.evals.length) point.evals = beRec.evals;
  point.usedFallback = !!beRec.used_fallback;
  point.nullEvals = beRec.null_evals||0;
  point.engineEvals = beRec.engine_evals||0;
  point.source = beRec.has_analysis ? 'backend' : point.source;
}

async function runBackend(user,range,timeClass,limit,token){
  setStatus('Backend: starting job…');
  let jobId;
  try{
    jobId=await startBackendJob(user,range,timeClass,limit);
    setBackendJobChip(`Job ${jobId.slice(0,8)}: queued`);
  }catch(e){
    setBackendJobChip(`Job kickoff failed: ${e.message}`);
    setStatus('Backend kickoff failed — falling back to local.');
    BACKEND.healthy=false; setBackendChip('Backend: kickoff failed','bad');
    return runLocal(user,range,timeClass,limit,token);
  }

  // Pull chess.com archive in parallel so we have PGN-shaped objects for the
  // feed/details panel. If it fails we still render from backend rows.
  let ccPromise = null;
  if(current.user!==user||!current.games.length){
    current.user=user;
    ccPromise = loadData(user).then(g=>{current.games=g;}).catch(()=>{current.games=[];});
  }

  // Poll loop: refresh games payload + job status every couple of seconds.
  let lastStatus='queued';
  let filtered = [];
  let points = [];
  // Eagerly render an empty state immediately.
  els.gamesFeed().innerHTML='<div class="sub" style="padding:14px">Waiting for backend analysis…</div>';

  while(true){
    if(token!==runToken) return;
    let job=null, gamesResp=null;
    try{ job=await fetchBackendJob(jobId); }catch{ /* keep polling */ }
    try{ gamesResp=await fetchBackendGames(user,range,timeClass,limit); }catch{ /* keep polling */ }
    if(job){
      BACKEND.jobStatus=job; lastStatus=job.status;
      setBackendJobChip(`Job ${jobId.slice(0,8)}: ${job.status} ${job.progress}/${job.total} ${job.message||''}`);
      setStatus(job.status==='running'?`Backend analysing ${job.progress}/${job.total}…`
              :job.status==='completed'?`Backend done: ${job.progress}/${job.total} games.`
              :job.status==='failed'?`Backend job failed: ${job.error||'unknown'}`
              :`Backend: ${job.status}`);
    }
    if(gamesResp && Array.isArray(gamesResp.games) && gamesResp.games.length){
      // Build filtered from backend rows (oldest-first); merge chess.com PGN if available.
      await (ccPromise||Promise.resolve());
      const ccByUrl=new Map((current.games||[]).map(g=>[g.url,g]));
      filtered = gamesResp.games.map(g=> ccByUrl.get(g.game_url) || backendGameToChesscomShape(g));
      points = pointsFromGames(filtered,user);
      for(let i=0;i<filtered.length;i++){
        const be = BACKEND.byUrl.get(filtered[i].url);
        if(be) applyBackendRowToPoint(points[i], be);
      }
      updateProgressive(points, filtered, points.filter(p=>p.source==='backend').length, points.length);
    }
    if(lastStatus==='completed' || lastStatus==='failed') break;
    await new Promise(r=>setTimeout(r,2000));
  }

  // For any game the backend couldn't analyse (e.g. transient error), fall
  // back to the local engine so the user still sees something.
  if(lastStatus==='completed' && filtered.length){
    for(let i=0;i<filtered.length;i++){
      if(token!==runToken) return;
      if(points[i].source==='backend') continue;
      setStatus(`Local fallback for game ${i+1}/${filtered.length}…`);
      try{
        const eng=await evaluateGameMoveByMove(filtered[i],user);
        if(eng){
          points[i].myEng=Math.round(eng.myEngineElo);
          points[i].oppEng=Math.round(eng.oppEngineElo);
          points[i].evals=eng.evals;
          points[i].usedFallback=!!eng.usedFallback;
          points[i].nullEvals=eng.nullEvals||0;
          points[i].engineEvals=eng.engineEvals||0;
          points[i].source=eng.source||'local';
          updateProgressive(points,filtered,i+1,filtered.length);
        }
      }catch(e){ console.warn('local fallback failed for game',i,e); }
    }
    setStatus(`Done. ${filtered.length} games (backend ${points.filter(p=>p.source==='backend').length}, local ${points.filter(p=>p.source==='local').length}).`);
  }
}

async function runLocal(user,range,timeClass,limit,token){
  if(!selfTested){ selfTested=true; await runEngineSelfTest(); setStatus('Engine self-test complete. Starting game evaluations...'); }
  if(current.user!==user||!current.games.length){current.user=user;current.games=await loadData(user);}
  const filtered=filterGames(current.games,user,range,timeClass,limit);
  const points=pointsFromGames(filtered,user);
  updateProgressive(points,filtered,0,filtered.length);
  for(let i=0;i<filtered.length;i++){
    if(token!==runToken) return;
    setStatus(`Evaluating game ${i+1}/${filtered.length}...`);
    const eng=await evaluateGameMoveByMove(filtered[i],user,(mv,totalMv)=>{setStatus(`Evaluating game ${i+1}/${filtered.length} • move ${mv}/${totalMv}`);});
    points[i].myEng=Math.round(eng.myEngineElo);
    points[i].oppEng=Math.round(eng.oppEngineElo);
    points[i].evals=eng.evals;
    points[i].usedFallback=!!eng.usedFallback || (Math.round(eng.myEngineElo)===500 && Math.round(eng.oppEngineElo)===500);
    points[i].nullEvals=eng.nullEvals||0;
    points[i].engineEvals=eng.engineEvals||0;
    points[i].source=eng.source||'local';
    updateProgressive(points,filtered,i+1,filtered.length);
  }
}

async function run(){
  const user=els.username().value.trim();
  const range=els.rangeFilter().value;
  const timeClass=els.timeClassFilter().value;
  const limit=Number(els.gameCountFilter().value)||100;
  const token=++runToken;
  setStatus('Loading...');
  try{
    const preferBackend = (els.preferBackend()?.checked!==false);
    if(preferBackend){ await probeBackend(); }
    if(preferBackend && BACKEND.healthy){
      await runBackend(user,range,timeClass,limit,token);
    } else {
      await runLocal(user,range,timeClass,limit,token);
    }
  } catch(e){setStatus(`Error: ${e.message}`); console.error(e);}
}

els.loadBtn().addEventListener('click',run);els.rangeFilter().addEventListener('change',run);els.timeClassFilter().addEventListener('change',run);els.gameCountFilter().addEventListener('change',run);

if(els.backendUrl()){
  els.backendUrl().addEventListener('change',()=>{
    BACKEND.url = (els.backendUrl().value||DEFAULT_BACKEND_URL).replace(/\/+$/,'');
    localStorage.setItem('backendUrl', BACKEND.url);
    BACKEND.urlSource='localStorage';
    BACKEND.byUrl.clear(); BACKEND.detailCache.clear();
    probeBackend();
  });
}
if(els.backendConnectBtn()){
  els.backendConnectBtn().addEventListener('click',()=>{
    BACKEND.url = (els.backendUrl().value||DEFAULT_BACKEND_URL).replace(/\/+$/,'');
    localStorage.setItem('backendUrl', BACKEND.url);
    BACKEND.urlSource='localStorage';
    BACKEND.byUrl.clear(); BACKEND.detailCache.clear();
    probeBackend();
  });
}
(async()=>{
  await discoverBackendUrl();
  if(els.backendUrl()) els.backendUrl().value = BACKEND.url;
  await probeBackend();
  run();
})();
