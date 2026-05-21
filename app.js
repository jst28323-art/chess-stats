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
async function fetchTunnelJsonUrl(){
  try{
    const r=await fetch('./tunnel.json?ts='+Date.now(),{cache:'no-store'});
    if(!r.ok) return null;
    const j=await r.json();
    return j && j.backendUrl ? String(j.backendUrl).replace(/\/+$/,'') : null;
  }catch{ return null; }
}
async function probeOne(url){
  try{
    const r=await fetch(url+'/health',{mode:'cors',cache:'no-store'});
    if(!r.ok) return null;
    return await r.json();
  }catch{ return null; }
}
async function findWorkingBackend(){
  // Probe candidates in priority order; use the FIRST that responds. This
  // means a stale localStorage entry (e.g. http://localhost:8787 saved from a
  // different PC) no longer wedges us -- we fall through to tunnel.json.
  const lsUrl = (localStorage.getItem('backendUrl')||'').replace(/\/+$/,'');
  const tunnelUrl = await fetchTunnelJsonUrl();
  const seen = new Set();
  const candidates = [];
  const add=(url,source)=>{ if(url && !seen.has(url)){ seen.add(url); candidates.push({url,source}); } };
  add(lsUrl,        'localStorage');
  add(tunnelUrl,    'tunnel.json');
  add(DEFAULT_BACKEND_URL, 'default');

  let triedLs = false;
  for(const c of candidates){
    if(c.source==='localStorage') triedLs = true;
    const info = await probeOne(c.url);
    if(!info) continue;
    BACKEND.url = c.url; BACKEND.urlSource = c.source;
    BACKEND.info = info; BACKEND.online = true;
    BACKEND.healthy = !!info?.stockfish?.available;
    const srcTag = c.source==='tunnel.json'?' • via tunnel.json'
                 : c.source==='localStorage'?' • user-set'
                 : ' • default';
    if(BACKEND.healthy) setBackendChip(`Backend: online • ${info.engine_profile}${srcTag}`,'good');
    else setBackendChip(`Backend: online but stockfish missing${srcTag}`,'warn');
    // If we fell back past a stale localStorage entry, clear it so future
    // loads don't waste a probe on a dead URL.
    if(triedLs && lsUrl && c.source!=='localStorage'){
      localStorage.removeItem('backendUrl');
      console.info(`stale backendUrl=${lsUrl} in localStorage; cleared. Using ${c.url} (${c.source}).`);
    }
    return;
  }
  // Nothing responded.
  BACKEND.online = false; BACKEND.healthy = false; BACKEND.info = null;
  BACKEND.url = lsUrl || tunnelUrl || DEFAULT_BACKEND_URL;
  BACKEND.urlSource = lsUrl?'localStorage':(tunnelUrl?'tunnel.json':'default');
  setBackendChip(`Backend: offline — tried ${candidates.length} candidate${candidates.length===1?'':'s'}`,'bad');
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

// Use the SOLID (Unicode "black-piece") glyphs for both colors and recolor
// via CSS — the outlined "white-piece" glyphs (♔♕♖♗♘♙) read as empty
// outlines on light squares. Filled glyphs + color:#fff + black stroke give
// real white pieces that pop against either square color.
const PIECE_SOLID={p:'♟',n:'♞',b:'♝',r:'♜',q:'♛',k:'♚'};
const WHITE_STROKE='text-shadow:0 0 1px #000,1px 0 0 #000,-1px 0 0 #000,0 1px 0 #000,0 -1px 0 #000';
const BLACK_STROKE='text-shadow:0 0 1px rgba(255,255,255,.4)';
function renderFenBoard(fen, flip=false){
  // Expand FEN ranks to 8-length arrays (board[0] = rank 8, board[7] = rank 1).
  const board=fen.split(' ')[0].split('/').map(rank=>{
    const out=[]; for(const ch of rank){
      if(/\d/.test(ch)){ for(let k=0;k<Number(ch);k++) out.push(null); }
      else out.push(ch);
    } return out;
  });
  // Display order: when flipped (user played black), render rank 1 at top
  // and files h-a left-to-right. Square color still derives from underlying
  // (r,f) FEN coords so the parity is identical -- only iteration order changes.
  const rankOrder = flip ? [7,6,5,4,3,2,1,0] : [0,1,2,3,4,5,6,7];
  const fileOrder = flip ? [7,6,5,4,3,2,1,0] : [0,1,2,3,4,5,6,7];
  let html='<div style="display:grid;grid-template-columns:repeat(8,42px);gap:0;border:1px solid #999;width:max-content;border-radius:4px;overflow:hidden">';
  for(const r of rankOrder){
    for(const f of fileOrder){
      const dark=(r+f)%2===1;
      const ch=board[r][f];
      if(!ch){
        html+=`<div style="width:42px;height:42px;background:${dark?'#769656':'#eeeed2'}"></div>`;
      } else {
        const isWhite = ch===ch.toUpperCase();
        const glyph = PIECE_SOLID[ch.toLowerCase()]||'';
        const color = isWhite?'#ffffff':'#1d1d1f';
        const stroke = isWhite?WHITE_STROKE:BLACK_STROKE;
        html+=`<div style="width:42px;height:42px;display:flex;align-items:center;justify-content:center;background:${dark?'#769656':'#eeeed2'}"><span style="font-size:32px;line-height:1;color:${color};${stroke}">${glyph}</span></div>`;
      }
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
function renderFeed(games,points){
  els.feedCount().textContent=`${games.length} games`;
  const feed=els.gamesFeed();
  // Cap visible rows to ~10 and let users scroll for the rest. Keep newest at top.
  feed.style.maxHeight='560px';
  feed.style.overflowY='auto';
  const order=[]; for(let i=games.length-1;i>=0;i--) order.push(i);
  feed.innerHTML=order.map(i=>{
    const g=games[i], p=perspective(g,current.user), e=points[i];
    const d=new Date(g.end_time*1000).toISOString().slice(0,10);
    const src=e.source==='backend'?'B':(e.source==='local'?'L':'·');
    return `<button class='game-row' data-idx='${i}'><span>${d}</span><span>${g.time_class}</span><span>${p.me.username} (${p.me.rating}) vs ${p.opp.username} (${p.opp.rating})</span><span class='${p.outcome.toLowerCase()}'>${p.outcome}</span><span class='tag'>${src} Eng ${e.myEng??'-'}/${e.oppEng??'-'}${e.usedFallback?'*':''}</span></button>`;
  }).join('');
}

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

// ===========================================================
// Coach-style analytics over per-ply evaluations
// ===========================================================
const CP_BLUNDER=200, CP_MISTAKE=100, CP_INACC=50, CP_GOOD=15;
function cpToWinPct(cp){ return 50 + 50*(2/(1+Math.exp(-0.00368208*cp)) - 1); }
function _moveAcc(winBefore, winAfter, isMoverWhite){
  const drop = isMoverWhite ? (winBefore - winAfter) : (winAfter - winBefore);
  const d = Math.max(0, drop);
  return Math.max(0, Math.min(100, 103.1668*Math.exp(-0.04354*d) - 3.1668));
}
function _classify(cpLoss){
  if(cpLoss >= CP_BLUNDER) return 'blunder';
  if(cpLoss >= CP_MISTAKE) return 'mistake';
  if(cpLoss >= CP_INACC) return 'inaccuracy';
  if(cpLoss >= CP_GOOD) return 'good';
  return 'best';
}
function analyzeEvals(evals, meWhite){
  if(!Array.isArray(evals) || evals.length < 2) return null;
  const a = {
    accuracy:{me:null,opp:null},
    classifications:{me:{best:0,good:0,inaccuracy:0,mistake:0,blunder:0},opp:{best:0,good:0,inaccuracy:0,mistake:0,blunder:0}},
    phases:{opening:{meLoss:0,meN:0,oppLoss:0,oppN:0},middlegame:{meLoss:0,meN:0,oppLoss:0,oppN:0},endgame:{meLoss:0,meN:0,oppLoss:0,oppN:0}},
    biggestMyLoss:0, biggestMyLossPly:null, firstBlunderPly:null,
  };
  let prev=evals[0], prevWin=cpToWinPct(prev);
  let myAccSum=0,myAccN=0,oppAccSum=0,oppAccN=0;
  for(let i=1;i<evals.length;i++){
    const cp=evals[i], win=cpToWinPct(cp);
    const whiteMove=((i-1)%2===0);
    const meMoved=(meWhite&&whiteMove)||(!meWhite&&!whiteMove);
    const loss = whiteMove ? Math.max(0, prev-cp) : Math.max(0, cp-prev);
    const phase = i<=20?'opening':i<=50?'middlegame':'endgame';
    if(meMoved){
      const acc=_moveAcc(prevWin,win,meWhite); myAccSum+=acc; myAccN++;
      a.classifications.me[_classify(loss)]++;
      a.phases[phase].meLoss+=loss; a.phases[phase].meN++;
      if(loss>a.biggestMyLoss){ a.biggestMyLoss=loss; a.biggestMyLossPly=i; }
      if(a.firstBlunderPly===null && loss>=CP_BLUNDER) a.firstBlunderPly=i;
    } else {
      const acc=_moveAcc(prevWin,win,!meWhite); oppAccSum+=acc; oppAccN++;
      a.classifications.opp[_classify(loss)]++;
      a.phases[phase].oppLoss+=loss; a.phases[phase].oppN++;
    }
    prev=cp; prevWin=win;
  }
  a.accuracy.me = myAccN?myAccSum/myAccN:null;
  a.accuracy.opp = oppAccN?oppAccSum/oppAccN:null;
  return a;
}

function aggregateInsights(filtered, points, user){
  const perGame = points.map((p,i)=>{
    const g=filtered[i], persp=perspective(g,user);
    return {gameIdx:i, game:g, point:p, persp, analytics:analyzeEvals(p.evals, persp.meWhite)};
  });
  const valid = perGame.filter(v=>v.analytics);
  if(!valid.length) return null;
  const myCls={best:0,good:0,inaccuracy:0,mistake:0,blunder:0}, oppCls={...myCls};
  for(const v of valid){ for(const k of Object.keys(myCls)){ myCls[k]+=v.analytics.classifications.me[k]; oppCls[k]+=v.analytics.classifications.opp[k]; } }
  const myTotal = Object.values(myCls).reduce((a,b)=>a+b,0);
  const phases = {opening:{me:0,meN:0,opp:0,oppN:0},middlegame:{me:0,meN:0,opp:0,oppN:0},endgame:{me:0,meN:0,opp:0,oppN:0}};
  for(const v of valid){ for(const ph of Object.keys(phases)){ phases[ph].me+=v.analytics.phases[ph].meLoss; phases[ph].meN+=v.analytics.phases[ph].meN; phases[ph].opp+=v.analytics.phases[ph].oppLoss; phases[ph].oppN+=v.analytics.phases[ph].oppN; } }
  // conversion / resilience at move ~20 (ply 40)
  let leadingN=0,leadingWins=0,losingN=0,losingSaves=0;
  for(const v of valid){
    const e=v.point.evals||[]; if(e.length<21) continue;
    const at=Math.min(40,e.length-1); const cp=e[at]; const mc=v.persp.meWhite?cp:-cp;
    if(mc>=200){ leadingN++; if(v.persp.outcome==='Win') leadingWins++; }
    else if(mc<=-200){ losingN++; if(v.persp.outcome!=='Loss') losingSaves++; }
  }
  // top blunders
  const topBlunders = valid.filter(v=>v.analytics.biggestMyLoss>=CP_BLUNDER)
    .map(v=>({gameIdx:v.gameIdx, ply:v.analytics.biggestMyLossPly, cpLoss:v.analytics.biggestMyLoss,
              date:v.game.end_time, outcome:v.persp.outcome, opp:(v.persp.opp&&v.persp.opp.username)||v.game.opp_user||'?'}))
    .sort((a,b)=>b.cpLoss-a.cpLoss).slice(0,5);
  // tilt
  const tilt={afterLoss:{n:0,sum:0},afterWin:{n:0,sum:0},afterDraw:{n:0,sum:0}};
  for(let i=1;i<valid.length;i++){
    const po=valid[i-1].persp.outcome, ma=valid[i].analytics.accuracy.me;
    if(ma==null) continue;
    if(po==='Loss'){ tilt.afterLoss.n++; tilt.afterLoss.sum+=ma; }
    else if(po==='Win'){ tilt.afterWin.n++; tilt.afterWin.sum+=ma; }
    else { tilt.afterDraw.n++; tilt.afterDraw.sum+=ma; }
  }
  // by color
  const w={n:0,wins:0,draws:0,losses:0,accSum:0,accN:0}, b={...w,accSum:0,accN:0};
  for(const v of valid){
    const k=v.persp.meWhite?w:b; k.n++;
    if(v.persp.outcome==='Win') k.wins++; else if(v.persp.outcome==='Draw') k.draws++; else k.losses++;
    if(v.analytics.accuracy.me!=null){ k.accSum+=v.analytics.accuracy.me; k.accN++; }
  }
  // weekday / hour
  const weekdayStats=Array.from({length:7},()=>({n:0,wins:0,accSum:0,accN:0}));
  const hourStats=Array.from({length:24},()=>({n:0,wins:0,accSum:0,accN:0}));
  for(const v of valid){
    const d=new Date(v.game.end_time*1000), wd=d.getDay(), hr=d.getHours();
    weekdayStats[wd].n++; hourStats[hr].n++;
    if(v.persp.outcome==='Win'){ weekdayStats[wd].wins++; hourStats[hr].wins++; }
    if(v.analytics.accuracy.me!=null){ weekdayStats[wd].accSum+=v.analytics.accuracy.me; weekdayStats[wd].accN++; hourStats[hr].accSum+=v.analytics.accuracy.me; hourStats[hr].accN++; }
  }
  // by time control
  const byTimeControl=new Map();
  for(const v of valid){
    const tc=v.game.time_class||'?';
    if(!byTimeControl.has(tc)) byTimeControl.set(tc,{n:0,wins:0,draws:0,losses:0,accSum:0,accN:0,blun:0,plays:0});
    const b2=byTimeControl.get(tc); b2.n++;
    if(v.persp.outcome==='Win') b2.wins++; else if(v.persp.outcome==='Draw') b2.draws++; else b2.losses++;
    if(v.analytics.accuracy.me!=null){ b2.accSum+=v.analytics.accuracy.me; b2.accN++; }
    b2.blun+=v.analytics.classifications.me.blunder;
    b2.plays+=Object.values(v.analytics.classifications.me).reduce((a,c)=>a+c,0);
  }
  const myAccs=valid.map(x=>x.analytics.accuracy.me).filter(v=>v!=null);
  const oppAccs=valid.map(x=>x.analytics.accuracy.opp).filter(v=>v!=null);
  return {
    perGame, valid,
    avgMyAccuracy: myAccs.length?myAccs.reduce((a,b)=>a+b,0)/myAccs.length:null,
    avgOppAccuracy: oppAccs.length?oppAccs.reduce((a,b)=>a+b,0)/oppAccs.length:null,
    myClassifications:myCls, oppClassifications:oppCls, myMoveTotal:myTotal,
    phases, conversion:{leadingN,leadingWins,losingN,losingSaves},
    topBlunders, tilt, byColor:{white:w,black:b},
    weekdayStats, hourStats, byTimeControl,
  };
}

function generateCoachNotes(ins){
  if(!ins) return [];
  const n=[];
  const acc=ins.avgMyAccuracy;
  if(acc!=null){
    if(acc>=85) n.push(`Excellent accuracy at ${acc.toFixed(1)}% — you're consistently finding strong moves. Focus your study on the few decisive moments per game.`);
    else if(acc>=75) n.push(`Solid accuracy ${acc.toFixed(1)}%. The next gain is converting "good" moves into "best" via slower critical-position review.`);
    else if(acc>=65) n.push(`Accuracy ${acc.toFixed(1)}%. Reducing blunders is the highest-leverage fix — drill tactics + 1-move blunder-check on every move.`);
    else n.push(`Accuracy ${acc.toFixed(1)}% suggests frequent tactical leaks. Slow the time control if possible and add a deliberate blunder-check.`);
  }
  const ph=ins.phases;
  const phAvg={opening:ph.opening.meN?ph.opening.me/ph.opening.meN:0, middlegame:ph.middlegame.meN?ph.middlegame.me/ph.middlegame.meN:0, endgame:ph.endgame.meN?ph.endgame.me/ph.endgame.meN:0};
  const wp=Object.entries(phAvg).reduce((a,b)=>b[1]>a[1]?b:a, ['none',0]);
  if(wp[1]>25){
    const advice = wp[0]==='opening' ? 'sharpen your opening repertoire and book moves'
                 : wp[0]==='middlegame' ? 'work tactics puzzles and study typical plans for the pawn structures you play'
                 : 'drill K+P, R+P, and basic theoretical endgames; learn opposition and key squares';
    n.push(`Weakest phase: ${wp[0]} — averaging ${wp[1].toFixed(0)} cp lost per move. To fix: ${advice}.`);
  }
  const c=ins.conversion;
  if(c.leadingN>=3){
    const r=c.leadingWins/c.leadingN*100;
    if(r<60) n.push(`Conversion leak: when up ≥2 pawns at move 20, you only win ${r.toFixed(0)}% (${c.leadingWins}/${c.leadingN}). Practice technical endgames vs liquidation to a known win.`);
    else if(r>85) n.push(`Strong technique — converts ${r.toFixed(0)}% of winning positions (${c.leadingWins}/${c.leadingN}).`);
  }
  if(c.losingN>=3){
    const r=c.losingSaves/c.losingN*100;
    if(r>35) n.push(`Resilient defender — saves ${r.toFixed(0)}% of losing positions (${c.losingSaves}/${c.losingN}). Good defensive practice.`);
    else if(r<10 && c.losingN>=5) n.push(`Losing positions stay lost (${r.toFixed(0)}% saves). Try complicating earlier with sacs / counterplay rather than passive defence.`);
  }
  const t=ins.tilt;
  if(t.afterLoss.n>=3 && t.afterWin.n>=3){
    const aL=t.afterLoss.sum/t.afterLoss.n, aW=t.afterWin.sum/t.afterWin.n;
    if(aW-aL>4) n.push(`Tilt signal: accuracy drops from ${aW.toFixed(1)}% after wins to ${aL.toFixed(1)}% after losses (Δ${(aW-aL).toFixed(1)}). Consider stopping after 2 consecutive losses.`);
  }
  const wc=ins.byColor.white, bc=ins.byColor.black;
  if(wc.n>=3 && bc.n>=3){
    const wr=wc.wins/wc.n, br=bc.wins/bc.n;
    if(Math.abs(wr-br)>0.15){
      const weak=wr>br?'black':'white';
      n.push(`Color split: ${(wr*100).toFixed(0)}% as white vs ${(br*100).toFixed(0)}% as black. Your ${weak} repertoire is the weak link.`);
    }
  }
  if(ins.myMoveTotal>0){
    const br=ins.myClassifications.blunder/ins.myMoveTotal*100;
    if(br>4) n.push(`Blunder rate ${br.toFixed(1)}% (one every ${Math.round(ins.myMoveTotal/Math.max(1,ins.myClassifications.blunder))} moves). This single metric is your highest-leverage improvement target.`);
    else if(br<1.5) n.push(`Low blunder rate (${br.toFixed(1)}%). Remaining gains will come from "good→best" upgrades in critical positions.`);
  }
  if(ins.topBlunders.length){
    const tb=ins.topBlunders[0];
    n.push(`Worst single move cost ${tb.cpLoss} cp vs ${tb.opp} (${tb.outcome}). Click "Top blunders" below to review.`);
  }
  return n;
}

// ---- Renderers ----
function fmtAcc(v){ return v==null?'—':`${v.toFixed(1)}%`; }
function renderInsightsKpis(ins){
  if(!ins){ els.advancedKpis().innerHTML='<div class="sub" style="padding:14px">Insights will appear once games finish analyzing.</div>'; return; }
  const cl=ins.myClassifications, t=ins.myMoveTotal||1, c=ins.conversion;
  const w=ins.byColor.white, b=ins.byColor.black;
  const pct=(a,total)=>total>0?`${(a/total*100).toFixed(1)}%`:'—';
  const cards=[
    ['Your accuracy', fmtAcc(ins.avgMyAccuracy)],
    ['Opp accuracy', fmtAcc(ins.avgOppAccuracy)],
    ['Blunder rate', pct(cl.blunder,t)],
    ['Mistake rate', pct(cl.mistake,t)],
    ['Conversion (≥+2 @ 20)', c.leadingN?`${(c.leadingWins/c.leadingN*100).toFixed(0)}%  (${c.leadingWins}/${c.leadingN})`:'—'],
    ['Resilience (≤−2 @ 20)', c.losingN?`${(c.losingSaves/c.losingN*100).toFixed(0)}%  (${c.losingSaves}/${c.losingN})`:'—'],
    ['As white  W/D/L', w.n?`${w.wins}/${w.draws}/${w.losses}  ·  ${(w.wins/w.n*100).toFixed(0)}%`:'—'],
    ['As black  W/D/L', b.n?`${b.wins}/${b.draws}/${b.losses}  ·  ${(b.wins/b.n*100).toFixed(0)}%`:'—'],
  ];
  els.advancedKpis().innerHTML=cards.map(([k,v])=>`<div class='glass card'><div class='k'>${k}</div><div class='v' style='font-size:20px'>${v}</div></div>`).join('');
}
function drawAccuracyTrend(ins){
  const labels=ins.valid.map((_,i)=>`#${i+1}`);
  const my=ins.valid.map(v=>v.analytics.accuracy.me);
  const opp=ins.valid.map(v=>v.analytics.accuracy.opp);
  charts.accTrend?.destroy?.();
  charts.accTrend=makeLineChart(document.getElementById('accuracyTrendChart'),{
    type:'line', data:{labels, datasets:[
      {label:'Your accuracy %', data:my, borderColor:'#0071e3', tension:0.2},
      {label:'Opp accuracy %', data:opp, borderColor:'#8e8e93', borderDash:[4,4], tension:0.2},
    ]},
    options:{plugins:{title:{display:true,text:'Per-game accuracy %'}},scales:{y:{min:0,max:100,title:{display:true,text:'Accuracy %'}}}}
  });
}
function drawPhaseMistakes(ins){
  const k=['opening','middlegame','endgame'];
  const me=k.map(x=>ins.phases[x].meN?ins.phases[x].me/ins.phases[x].meN:0);
  const op=k.map(x=>ins.phases[x].oppN?ins.phases[x].opp/ins.phases[x].oppN:0);
  charts.phase?.destroy?.();
  charts.phase=new Chart(document.getElementById('phaseMistakeChart'),{
    type:'bar', data:{labels:['Opening (1-20)','Middlegame (21-50)','Endgame (51+)'],datasets:[
      {label:'You — cp lost / move', data:me, backgroundColor:'#b42318'},
      {label:'Opp — cp lost / move', data:op, backgroundColor:'#a0a0a0'},
    ]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{title:{display:true,text:'Average centipawn loss per move by phase'}},scales:{y:{title:{display:true,text:'Cp lost / move'}}}}
  });
}
function drawMoveClassChart(ins){
  const cl=ins.myClassifications, op=ins.oppClassifications;
  const labels=['Best','Good','Inaccuracy','Mistake','Blunder'];
  const me=[cl.best,cl.good,cl.inaccuracy,cl.mistake,cl.blunder];
  const oo=[op.best,op.good,op.inaccuracy,op.mistake,op.blunder];
  charts.moveClass?.destroy?.();
  charts.moveClass=new Chart(document.getElementById('moveClassChart'),{
    type:'bar', data:{labels, datasets:[
      {label:'You', data:me, backgroundColor:['#1a7f37','#86c876','#175cd3','#b54708','#b42318']},
      {label:'Opp', data:oo, backgroundColor:'rgba(140,140,140,.55)'},
    ]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{title:{display:true,text:'Move classification distribution'},legend:{position:'top'}},scales:{y:{title:{display:true,text:'Move count'}}}}
  });
}
function drawWeekdayChart(ins){
  const N=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const ws=ins.weekdayStats;
  charts.weekday?.destroy?.();
  charts.weekday=new Chart(document.getElementById('weekdayChart'),{
    data:{labels:N, datasets:[
      {type:'bar', label:'Games', data:ws.map(d=>d.n), backgroundColor:'#cfe2ff', yAxisID:'yG'},
      {type:'line', label:'Win %', data:ws.map(d=>d.n?(d.wins/d.n*100):0), borderColor:'#1a7f37', yAxisID:'yW', tension:0.2},
    ]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{title:{display:true,text:'Games & win rate by weekday'}},scales:{yG:{type:'linear',position:'left',title:{display:true,text:'Games'}},yW:{type:'linear',position:'right',min:0,max:100,title:{display:true,text:'Win %'},grid:{drawOnChartArea:false}}}}
  });
}
function drawHourChart(ins){
  const hs=ins.hourStats;
  charts.hour?.destroy?.();
  charts.hour=new Chart(document.getElementById('hourChart'),{
    data:{labels:hs.map((_,i)=>`${i}h`), datasets:[
      {type:'bar', label:'Games', data:hs.map(d=>d.n), backgroundColor:'#fde0c2', yAxisID:'yG'},
      {type:'line', label:'Win %', data:hs.map(d=>d.n?(d.wins/d.n*100):0), borderColor:'#1a7f37', yAxisID:'yW', tension:0.2},
    ]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{title:{display:true,text:'Games & win rate by hour (local time)'}},scales:{yG:{type:'linear',position:'left',title:{display:true,text:'Games'}},yW:{type:'linear',position:'right',min:0,max:100,title:{display:true,text:'Win %'},grid:{drawOnChartArea:false}}}}
  });
}
function drawConversionChart(ins){
  const c=ins.conversion;
  const conv = c.leadingN?(c.leadingWins/c.leadingN*100):0;
  const res = c.losingN?(c.losingSaves/c.losingN*100):0;
  charts.conv?.destroy?.();
  charts.conv=new Chart(document.getElementById('conversionChart'),{
    type:'bar', data:{labels:['Conversion (≥+2)','Resilience (≤-2)'],datasets:[
      {label:'Rate %', data:[conv,res], backgroundColor:['#1a7f37','#175cd3']},
    ]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{title:{display:true,text:'Conversion & resilience at move 20'},legend:{display:false}},scales:{y:{min:0,max:100,title:{display:true,text:'%'}}}}
  });
}
function renderTimeControlTable(ins){
  const m=ins.byTimeControl; const t=document.getElementById('timeControlTable'); if(!t) return;
  if(!m || !m.size){ t.innerHTML='<tr><td>No data</td></tr>'; return; }
  const rows=['<tr><th>Time class</th><th>Games</th><th>W/D/L</th><th>Win %</th><th>Avg accuracy</th><th>Blunder rate</th></tr>'];
  for(const [tc,b] of m){
    rows.push(`<tr><td>${tc}</td><td>${b.n}</td><td>${b.wins}/${b.draws}/${b.losses}</td><td>${(b.wins/b.n*100).toFixed(0)}%</td><td>${b.accN?(b.accSum/b.accN).toFixed(1)+'%':'—'}</td><td>${b.plays?(b.blun/b.plays*100).toFixed(2)+'%':'—'}</td></tr>`);
  }
  t.innerHTML=rows.join('');
}
function renderCoachNotes(ins){
  const el=document.getElementById('coachNotes'); if(!el) return;
  const notes=generateCoachNotes(ins);
  if(!notes.length){ el.innerHTML='<div class="sub" style="padding:14px">Coach insights will appear here once games finish analyzing.</div>'; return; }
  el.innerHTML=`<div style="padding:14px"><div class='k' style='margin-bottom:8px'>Coach’s notes</div><ul style="margin:0;padding-left:18px;font-size:14px">${notes.map(n=>`<li style="margin:6px 0;line-height:1.4">${n}</li>`).join('')}</ul></div>`;
}
function renderTopBlunders(ins){
  const el=document.getElementById('topBlunders'); if(!el) return;
  if(!ins || !ins.topBlunders.length){ el.innerHTML='<div class="sub" style="padding:14px">No blunders flagged in this sample.</div>'; return; }
  const rows=ins.topBlunders.map(tb=>{
    const d=new Date(tb.date*1000).toISOString().slice(0,10);
    return `<button class='game-row' data-blunder-idx='${tb.gameIdx}' style='grid-template-columns:90px 64px 1fr 60px 92px'><span>${d}</span><span>Ply ${tb.ply}</span><span>vs ${tb.opp}</span><span class='${tb.outcome.toLowerCase()}'>${tb.outcome}</span><span class='tag blun'>−${tb.cpLoss} cp</span></button>`;
  });
  el.innerHTML=`<div style="padding:14px"><div class='k' style='margin-bottom:8px'>Top 5 blunders</div>${rows.join('')}</div>`;
  el.querySelectorAll('[data-blunder-idx]').forEach(btn=>btn.addEventListener('click',()=>{
    const idx=Number(btn.dataset.blunderIdx);
    // Feed is rendered newest-first but data-idx still points at the underlying array index.
    const target=document.querySelector(`#gamesFeed .game-row[data-idx="${idx}"]`);
    if(target){ target.scrollIntoView({behavior:'smooth',block:'center'}); target.click(); }
  }));
}

function drawFeedDetails(filtered,pointMap){
  const ins = aggregateInsights(filtered, pointMap, current.user);
  renderInsightsKpis(ins);
  if(ins){
    drawAccuracyTrend(ins);
    drawPhaseMistakes(ins);
    drawMoveClassChart(ins);
    drawWeekdayChart(ins);
    drawHourChart(ins);
    drawConversionChart(ins);
    renderTimeControlTable(ins);
    renderCoachNotes(ins);
    renderTopBlunders(ins);
  }
  els.gameDetails().innerHTML='<div class="sub">Click a game row to open move-by-move eval chart.</div>';
  document.querySelectorAll('.game-row').forEach(btn=>btn.addEventListener('click',async()=>{
    const i=Number(btn.dataset.idx); const p=pointMap[i];
    if(!p || !p.evals){ els.gameDetails().innerHTML='<div class="sub">No move-by-move eval available yet for this game.</div>'; return; }
    // Game header + board orientation: user color at the bottom.
    const persp = perspective(filtered[i], current.user);
    const meWhite = persp.meWhite;
    const flipBoard = !meWhite;
    const oppName = (persp.opp && persp.opp.username) || '?';
    const oppRating = (persp.opp && persp.opp.rating) || null;
    const myRating = (persp.me && persp.me.rating) || null;
    const tcLabel = (filtered[i].time_class||'').replace(/^./,c=>c.toUpperCase()) || 'Game';
    const dateStr = new Date(filtered[i].end_time*1000).toISOString().slice(0,10);
    const outcome = persp.outcome;
    // Eval bar order: opponent color always on top, user color on bottom.
    // Math is unchanged (ebWhite height = pct%, ebBlack height = 100-pct%);
    // we only reorder the DOM so "your color" sits at the bottom of the bar.
    const ebBlackDiv = `<div id="ebBlack" style="background:#1d1d1f;width:100%;height:50%;transition:height .35s cubic-bezier(.2,.7,.2,1)"></div>`;
    const ebWhiteDiv = `<div id="ebWhite" style="background:#f8f8fb;width:100%;height:50%;transition:height .35s cubic-bezier(.2,.7,.2,1);border-top:1px solid rgba(0,0,0,.25)"></div>`;
    const ebInner = meWhite ? (ebBlackDiv + ebWhiteDiv) : (ebWhiteDiv + ebBlackDiv);
    els.gameDetails().innerHTML=`
      <div style="margin-bottom:10px">
        <div style="font-size:16px;font-weight:600;letter-spacing:-.01em">vs ${oppName} <span style="color:var(--muted);font-weight:500">(${oppRating!=null?oppRating:'?'})</span></div>
        <div class="sub" style="font-size:12px;margin-top:2px">${tcLabel} · ${dateStr} · You played <b>${meWhite?'WHITE':'BLACK'}</b>${myRating!=null?` (${myRating})`:''} · <span class="${outcome.toLowerCase()}">${outcome}</span></div>
      </div>
      <div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap">
        <div style="display:flex;flex-direction:column;align-items:center;gap:6px">
          <div id="ebLabel" class="sub" style="font-size:13px;width:48px;text-align:center;font-variant-numeric:tabular-nums;font-weight:600;color:var(--text)">0.0</div>
          <div style="width:26px;height:336px;border:1px solid #999;display:flex;flex-direction:column;overflow:hidden;border-radius:4px;background:#1d1d1f;box-shadow:0 1px 4px rgba(0,0,0,.12)">
            ${ebInner}
          </div>
        </div>
        <div id="boardHost"></div>
      </div>
      <div class="toolbar" style="margin-top:10px">
        <button id="prevPly">Prev</button>
        <button id="nextPly">Next</button>
        <span id="plyMeta" class="sub"></span>
        <span class="sub" style="margin-left:auto;font-size:11px">← → arrow keys</span>
      </div>
      <div id="plyInfo" class="sub" style="margin-top:6px">Loading detailed line analysis...</div>
      <div class="chart-card" style="height:220px;margin-top:10px"><canvas id="gameEvalChart"></canvas></div>
    `;
    const evals = p.evals || [];
    charts.gameEval?.destroy?.();
    charts.gameEval=new Chart(document.getElementById('gameEvalChart'),{
      type:'line',
      data:{labels:evals.map((_,ix)=>ix),datasets:[{
        label:'Eval cp', data:evals, borderColor:'#0071e3', borderWidth:1.6, tension:0.15,
        pointRadius: evals.map(()=>0),
        pointBackgroundColor: evals.map(()=>'transparent'),
        pointBorderWidth: 0,
        pointHoverRadius: 4,
        pointHitRadius: 12,
      }]},
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{legend:{display:false}, title:{display:true,text:'Game eval — click to jump'}},
        interaction:{intersect:false, mode:'index'},
        onClick:(evt,items)=>{ if(items && items.length){ idx=items[0].index; render(); } },
      }
    });
    const rows=await analyzeGameDetailed(filtered[i],current.user);
    const ChessCtor=getChessCtor(); const chess=new ChessCtor(); const moves=parseMoves(filtered[i].pgn);
    const fens=[chess.fen()]; const caps=[null];
    for(const m of moves){ const mv=chess.move(m,{sloppy:true}); if(!mv) continue; fens.push(chess.fen()); caps.push(mv.captured?mv.captured:null); }
    let idx=0;

    const updateEvalBar = (cp, mateVal) => {
      let pct;
      if(mateVal != null){ pct = mateVal > 0 ? 100 : 0; }
      else if(cp == null){ pct = 50; }
      else { pct = Math.max(2, Math.min(98, cpToWinPct(cp))); }
      const ebW=document.getElementById('ebWhite'), ebB=document.getElementById('ebBlack');
      if(ebW) ebW.style.height = pct + '%';
      if(ebB) ebB.style.height = (100 - pct) + '%';
      const lbl=document.getElementById('ebLabel');
      if(lbl){
        if(mateVal != null){ lbl.textContent = (mateVal>0?'+':'-') + 'M' + Math.abs(mateVal); }
        else if(cp == null){ lbl.textContent = '—'; }
        else { const v = cp/100; lbl.textContent = (v>=0?'+':'') + v.toFixed(1); }
      }
    };
    const updateChartHighlight = () => {
      const ch = charts.gameEval; if(!ch) return;
      const ds = ch.data.datasets[0]; const n = ds.data.length;
      const radius = new Array(n).fill(0); const fill = new Array(n).fill('transparent');
      const safe = Math.max(0, Math.min(n-1, idx));
      radius[safe] = 6; fill[safe] = '#b42318';
      ds.pointRadius = radius; ds.pointBackgroundColor = fill;
      ch.update('none');
    };

    const render = () => {
      const fen = fens[Math.min(idx, fens.length-1)];
      document.getElementById('boardHost').innerHTML = renderFenBoard(fen, flipBoard);
      // Ply 0 = starting position (no row); ply k>=1 corresponds to rows[k-1].
      let r={}, cap=null, cp=null, mate=null;
      if(idx === 0){
        cp = evals[0] != null ? evals[0] : 0;
      } else {
        r = rows[idx-1] || {};
        cap = caps[idx];
        cp = (r.eval != null) ? r.eval : (evals[idx] != null ? evals[idx] : null);
        mate = (r.mate != null) ? r.mate : null;
      }
      updateEvalBar(cp, mate);
      updateChartHighlight();
      document.getElementById('plyMeta').textContent = `Ply ${idx}/${fens.length-1}`;
      const evalLabel = mate!=null ? `M${Math.abs(mate)}` : (cp!=null ? cp : 'n/a');
      if(idx === 0){
        document.getElementById('plyInfo').innerHTML = `<span class='sub'>Starting position. Eval: <b>${evalLabel}</b></span>`;
      } else {
        document.getElementById('plyInfo').innerHTML = `Played: <b>${r.move||'-'}</b> | Eval: <b>${evalLabel}</b> | Best: <b>${r.best||'-'}</b> | Captured: <b>${cap||'none'}</b><br/>PV: ${r.pv||'-'}`;
      }
    };
    document.getElementById('prevPly').onclick=()=>{ idx=Math.max(0,idx-1); render(); };
    document.getElementById('nextPly').onclick=()=>{ idx=Math.min(fens.length-1,idx+1); render(); };
    // Arrow-key navigation (single global handler, rebound each open).
    if(window.__chessReviewKeyHandler){ document.removeEventListener('keydown', window.__chessReviewKeyHandler); }
    const keyHandler = (e) => {
      if(e.target && (e.target.tagName==='INPUT' || e.target.tagName==='TEXTAREA' || e.target.isContentEditable)) return;
      if(e.key==='ArrowLeft'){ idx=Math.max(0,idx-1); render(); e.preventDefault(); }
      else if(e.key==='ArrowRight'){ idx=Math.min(fens.length-1,idx+1); render(); e.preventDefault(); }
    };
    window.__chessReviewKeyHandler = keyHandler;
    document.addEventListener('keydown', keyHandler);
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
    if(preferBackend){ await findWorkingBackend(); }
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
  await findWorkingBackend();
  if(els.backendUrl()) els.backendUrl().value = BACKEND.url;
  run();
})();
