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
// ----- arrow + classification helpers (used by review panel) -----
const ARROW_COLORS = {played:'#1d6cf2', best:'#2ea043', book:'#8b4513'};
const CLASS_STYLE = {
  brilliant: {label:'Brilliant', fg:'#0098f1', bg:'rgba(0,152,241,.13)'},
  best:      {label:'Best',      fg:'#1a7f37', bg:'rgba(26,127,55,.12)'},
  good:      {label:'Good',      fg:'#4b6b2a', bg:'rgba(75,107,42,.12)'},
  book:      {label:'Book',      fg:'#8b4513', bg:'rgba(139,69,19,.14)'},
  inaccuracy:{label:'Inaccuracy',fg:'#175cd3', bg:'rgba(23,92,211,.12)'},
  mistake:   {label:'Mistake',   fg:'#b54708', bg:'rgba(181,71,8,.14)'},
  blunder:   {label:'Blunder',   fg:'#b42318', bg:'rgba(180,35,24,.14)'},
};
function uciSquareToPx(sq, flip, size=42){
  if(!sq || sq.length<2) return null;
  const file=sq.charCodeAt(0)-97, rank=sq.charCodeAt(1)-49;
  if(file<0||file>7||rank<0||rank>7) return null;
  const col = flip ? (7-file) : file;
  const row = flip ? rank : (7-rank);
  return { x: col*size + size/2, y: row*size + size/2 };
}
function drawArrowsOnBoard(boardHost, arrows, flip){
  if(!boardHost || !arrows || !arrows.length) return;
  const boardEl = boardHost.firstElementChild;
  if(!boardEl) return;
  boardEl.style.position = 'relative';
  const NS = 'http://www.w3.org/2000/svg';
  const sz = 8*42;
  const svg = document.createElementNS(NS,'svg');
  svg.setAttribute('width',sz); svg.setAttribute('height',sz);
  svg.setAttribute('viewBox',`0 0 ${sz} ${sz}`);
  svg.setAttribute('style','position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none');
  const defs = document.createElementNS(NS,'defs');
  const colors = new Set(arrows.map(a=>a.color));
  for(const c of colors){
    const id = 'ah-'+c.replace(/[^a-z0-9]/gi,'');
    const m = document.createElementNS(NS,'marker');
    m.setAttribute('id', id);
    m.setAttribute('viewBox','0 0 10 10');
    m.setAttribute('refX','7'); m.setAttribute('refY','5');
    m.setAttribute('markerWidth','4.5'); m.setAttribute('markerHeight','4.5');
    m.setAttribute('orient','auto-start-reverse');
    const p = document.createElementNS(NS,'path');
    p.setAttribute('d','M0,0 L10,5 L0,10 z'); p.setAttribute('fill', c);
    m.appendChild(p); defs.appendChild(m);
  }
  svg.appendChild(defs);
  for(const a of arrows){
    const p = uciSquareToPx(a.from, flip), q = uciSquareToPx(a.to, flip);
    if(!p || !q) continue;
    const dx=q.x-p.x, dy=q.y-p.y, len=Math.hypot(dx,dy);
    if(len < 1) continue;
    const ux=dx/len, uy=dy/len, shortHead=14;
    const x2=q.x-ux*shortHead, y2=q.y-uy*shortHead;
    const line = document.createElementNS(NS,'line');
    line.setAttribute('x1',p.x); line.setAttribute('y1',p.y);
    line.setAttribute('x2',x2); line.setAttribute('y2',y2);
    line.setAttribute('stroke', a.color);
    line.setAttribute('stroke-width', a.width||5);
    line.setAttribute('stroke-linecap','round');
    line.setAttribute('opacity', a.opacity != null ? a.opacity : 0.85);
    line.setAttribute('marker-end', `url(#ah-${a.color.replace(/[^a-z0-9]/gi,'')})`);
    svg.appendChild(line);
  }
  boardEl.appendChild(svg);
}
function classifyPlyMove(rows, idx, evals){
  if(idx === 0) return null;
  const r = rows[idx-1]; if(!r) return null;
  const openingPly = (rows.opening && rows.opening.ply) || 0;
  if(idx <= openingPly) return 'book';
  const cpBefore = evals[idx-1], cpAfter = evals[idx];
  if(cpBefore == null || cpAfter == null) return null;
  const whiteMove = (idx % 2 === 1);
  const cpLoss = Math.max(0, whiteMove ? (cpBefore - cpAfter) : (cpAfter - cpBefore));
  if(r.is_best){
    if(r.is_sacrifice) return 'brilliant';
    return 'best';
  }
  if(cpLoss >= 200) return 'blunder';
  if(cpLoss >= 100) return 'mistake';
  if(cpLoss >= 50)  return 'inaccuracy';
  if(cpLoss >= 15)  return 'good';
  return 'best';
}
function renderClassBadge(cls){
  if(!cls) return '';
  const s = CLASS_STYLE[cls]; if(!s) return '';
  return `<span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:11.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${s.fg};background:${s.bg};border:1px solid ${s.fg}33;margin-right:6px">${s.label}</span>`;
}

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
function drawSkillGraph(points){charts.skill?.destroy?.();charts.skill=makeLineChart(els.ratingChart(),{type:'line',data:{labels:points.map(p=>p.label),datasets:[{label:'Your Chess.com Elo',data:points.map(p=>p.myElo),borderColor:'#0071e3',yAxisID:'yChess'},{label:'Opponent Chess.com Elo',data:points.map(p=>p.oppElo),borderColor:'#8e8e93',yAxisID:'yChess'},{label:'Your Engine Accuracy %',data:points.map(p=>p.myAcc),borderColor:'#1a7f37',yAxisID:'yAcc'},{label:'Opponent Engine Accuracy %',data:points.map(p=>p.oppAcc),borderColor:'#b42318',yAxisID:'yAcc'}]},options:{plugins:{title:{display:true,text:'Per-Game Skill Trend (Chess.com Elo + Engine Accuracy %)'}},scales:{yChess:{type:'linear',position:'left',title:{display:true,text:'Chess.com Elo'}},yAcc:{type:'linear',position:'right',min:0,max:100,grid:{drawOnChartArea:false},title:{display:true,text:'Engine Accuracy %'}}}}});}
function drawOpponentSpread(points){charts.opp?.destroy?.();charts.opp=new Chart(els.oppRatingChart(),{type:'scatter',data:{datasets:[{label:'Accuracy edge vs opponent Elo',data:points.filter(p=>p.myAcc!=null&&p.oppAcc!=null).map(p=>({x:p.oppElo,y:p.myAcc-p.oppAcc})),backgroundColor:'#0071e3'}]},options:{responsive:true,maintainAspectRatio:false,scales:{x:{title:{display:true,text:'Opponent Chess.com Elo'}},y:{title:{display:true,text:'Your accuracy − opp accuracy (pp)'}}}}});}
function drawVolume(points){charts.vol?.destroy?.();charts.vol=new Chart(els.volumeChart(),{type:'bar',data:{labels:points.map(p=>p.label),datasets:[{label:'Game index',data:points.map((_,i)=>i+1),backgroundColor:'#d6eaff'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},title:{display:true,text:'Games in selection'}}}});} 
function drawResults(points){charts.res?.destroy?.();charts.res=new Chart(els.resultChart(),{type:'line',data:{labels:points.map(p=>p.label),datasets:[{label:'Your Engine Accuracy %',data:points.map(p=>p.myAcc),borderColor:'#1a7f37'},{label:'Opp Engine Accuracy %',data:points.map(p=>p.oppAcc),borderColor:'#b42318'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{title:{display:true,text:'Engine Accuracy Comparison'}},scales:{y:{min:0,max:100,title:{display:true,text:'Accuracy %'}}}}});}
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
    const myA = e.myAcc!=null?`${e.myAcc.toFixed(0)}%`:'-';
    const opA = e.oppAcc!=null?`${e.oppAcc.toFixed(0)}%`:'-';
    return `<button class='game-row' data-idx='${i}'><span>${d}</span><span>${g.time_class}</span><span>${p.me.username} (${p.me.rating}) vs ${p.opp.username} (${p.opp.rating})</span><span class='${p.outcome.toLowerCase()}'>${p.outcome}</span><span class='tag'>${src} Acc ${myA}/${opA}${e.usedFallback?'*':''}</span></button>`;
  }).join('');
}

async function analyzeGameDetailed(g,user){
  if(BACKEND.healthy && g && g.url && BACKEND.byUrl.has(g.url)){
    const a=await fetchBackendGameAnalysis(g.url);
    if(a && Array.isArray(a.plies) && a.plies.length){
      const rows = a.plies.map(p=>({
        ply:p.ply, move:p.move, uci:p.uci,
        eval:p.eval, mate:p.mate,
        best:p.best||'-', best_uci:p.best_uci, pv:p.pv||'',
        fen:p.fen, capture:p.capture,
        is_best:!!p.is_best, is_sacrifice:!!p.is_sacrifice,
        played_reason:p.played_reason||null, best_reason:p.best_reason||null,
      }));
      // Attach opening metadata as a property of the array (used by the
      // review panel to show the opening name + last-book-move indicator).
      rows.opening = {
        eco: a.opening_eco || null,
        name: a.opening_name || null,
        ply: a.opening_ply || 0,
        next_uci: a.opening_next_uci || null,
      };
      return rows;
    }
  }
  const ChessCtor=getChessCtor();
  if(!ChessCtor) return [];
  const moves=parseMoves(g.pgn);
  const chess=new ChessCtor();
  const rows=[];
  for(let i=0;i<Math.min(moves.length,120);i++){
    const mv = chess.move(moves[i],{sloppy:true});
    if(!mv) continue;
    const uci = (mv.from||'') + (mv.to||'') + (mv.promotion||'');
    const obj=await evalFenWithRetry(chess.fen(),Math.max(8,EVAL_DEPTH));
    rows.push({
      ply:i+1, move:moves[i], uci,
      eval:obj&&typeof obj.score==='number'?obj.score:null,
      best:obj&&obj.bestmove?obj.bestmove:'-',
      best_uci:obj&&obj.bestmove?obj.bestmove:null,
      pv:obj&&obj.pv?obj.pv:'',
      is_best:false, is_sacrifice:false,
    });
  }
  rows.opening = {eco:null, name:null, ply:0, next_uci:null};
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
// Standard-deviation helper for the volatility window used in the
// Lichess-style weighted accuracy blend below.
function _stdDev(arr){
  if(arr.length < 2) return 0;
  const m = arr.reduce((s,x)=>s+x,0) / arr.length;
  const v = arr.reduce((s,x)=>s+(x-m)*(x-m),0) / arr.length;
  return Math.sqrt(v);
}
// Blend per-move accuracy values into a single game accuracy using the
// Lichess-published approach: weight each ply by the local win% volatility
// (so quiet "obvious" moves contribute less than tactical decisions), then
// average a weighted harmonic + weighted arithmetic mean. Harmonic mean is
// dragged down by the worst moves, which is exactly the behaviour we want
// when a player has a 13% blunder rate alongside lots of forced/easy moves.
function _weightedBlendedAcc(pairs){
  if(!pairs || !pairs.length) return null;
  let weightSum=0, accSum=0, recipSum=0;
  for(const {acc,weight} of pairs){
    weightSum += weight;
    accSum    += acc * weight;
    recipSum  += weight / Math.max(1, acc); // +1 floor to avoid div-by-zero on zero-accuracy moves
  }
  if(weightSum <= 0) return null;
  const arith    = accSum / weightSum;
  const harmonic = weightSum / recipSum;
  return (arith + harmonic) / 2;
}

// Volatility window for weighting (in plies). Each move's contribution to
// the blended accuracy is proportional to local win% std-dev, so quiet
// "obvious" moves naturally weigh less and the cp-cutoff filter we had in
// build .19 is no longer needed -- the weighting handles grinding plies
// for free.
const VOLATILITY_WINDOW = 4;

function analyzeEvals(evals, meWhite){
  if(!Array.isArray(evals) || evals.length < 2) return null;
  const a = {
    accuracy:{me:null,opp:null},
    classifications:{me:{best:0,good:0,inaccuracy:0,mistake:0,blunder:0},opp:{best:0,good:0,inaccuracy:0,mistake:0,blunder:0}},
    phases:{opening:{meLoss:0,meN:0,oppLoss:0,oppN:0},middlegame:{meLoss:0,meN:0,oppLoss:0,oppN:0},endgame:{meLoss:0,meN:0,oppLoss:0,oppN:0}},
    biggestMyLoss:0, biggestMyLossPly:null, firstBlunderPly:null,
    competitive_plies:0, decided_plies:0,
  };
  // Pre-compute win% array so we can read a small window around each ply.
  const wins = evals.map(cp=>cpToWinPct(cp));
  let prev=evals[0], prevWin=wins[0];
  const myPairs=[], oppPairs=[];
  for(let i=1;i<evals.length;i++){
    const cp=evals[i], win=wins[i];
    const whiteMove=((i-1)%2===0);
    const meMoved=(meWhite&&whiteMove)||(!meWhite&&!whiteMove);
    const loss = whiteMove ? Math.max(0, prev-cp) : Math.max(0, cp-prev);
    const phase = i<=20?'opening':i<=50?'middlegame':'endgame';
    a.competitive_plies++;
    // Volatility = std-dev of win% over the surrounding window. Clamped to
    // [0.5, 12] so a totally quiet position still has nonzero weight and a
    // single huge swing doesn't dwarf everything else.
    const start = Math.max(0, i - VOLATILITY_WINDOW);
    const end   = Math.min(wins.length, i + 1);
    const weight = Math.max(0.5, Math.min(12, _stdDev(wins.slice(start, end))));
    if(meMoved){
      a.classifications.me[_classify(loss)]++;
      a.phases[phase].meLoss+=loss; a.phases[phase].meN++;
      if(loss>a.biggestMyLoss){ a.biggestMyLoss=loss; a.biggestMyLossPly=i; }
      if(a.firstBlunderPly===null && loss>=CP_BLUNDER) a.firstBlunderPly=i;
      const acc=_moveAcc(prevWin,win,meWhite);
      myPairs.push({acc, weight});
    } else {
      a.classifications.opp[_classify(loss)]++;
      a.phases[phase].oppLoss+=loss; a.phases[phase].oppN++;
      const acc=_moveAcc(prevWin,win,!meWhite);
      oppPairs.push({acc, weight});
    }
    prev=cp; prevWin=win;
  }
  a.accuracy.me = _weightedBlendedAcc(myPairs);
  a.accuracy.opp = _weightedBlendedAcc(oppPairs);
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
  // conversion / resilience at move ~20 (ply 40) -- single-snapshot KPI
  let leadingN=0,leadingWins=0,losingN=0,losingSaves=0;
  for(const v of valid){
    const e=v.point.evals||[]; if(e.length<21) continue;
    const at=Math.min(40,e.length-1); const cp=e[at]; const mc=v.persp.meWhite?cp:-cp;
    if(mc>=200){ leadingN++; if(v.persp.outcome==='Win') leadingWins++; }
    else if(mc<=-200){ losingN++; if(v.persp.outcome!=='Loss') losingSaves++; }
  }
  // conversion / resilience tracked across every ply (for the line chart):
  //   leadingN[p]    = games where me-eval at ply p was >= +200
  //   leadingWins[p] = of those, how many ended in Win
  //   losingN[p]     = games where me-eval at ply p was <= -200
  //   losingSaves[p] = of those, how many ended Win|Draw
  const MAX_PLY = 200;
  const byPly = Array.from({length:MAX_PLY+1}, ()=>({leadingN:0, leadingWins:0, losingN:0, losingSaves:0}));
  for(const v of valid){
    const evals = v.point.evals || [];
    const meWhite = v.persp.meWhite;
    const isWin = v.persp.outcome === 'Win';
    const isSave = isWin || v.persp.outcome === 'Draw';
    const upTo = Math.min(evals.length, MAX_PLY + 1);
    for(let p=1; p<upTo; p++){
      const cp = evals[p];
      if(cp == null) continue;
      const mc = meWhite ? cp : -cp;
      if(mc >= 200){
        byPly[p].leadingN++;
        if(isWin) byPly[p].leadingWins++;
      } else if(mc <= -200){
        byPly[p].losingN++;
        if(isSave) byPly[p].losingSaves++;
      }
    }
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
  // Competitive / decided ply totals (across all games) for the "X of Y plies
  // counted" note in the KPI panel.
  let totalCompetitive=0, totalDecided=0;
  for(const v of valid){
    totalCompetitive += v.analytics.competitive_plies||0;
    totalDecided     += v.analytics.decided_plies||0;
  }
  return {
    perGame, valid,
    avgMyAccuracy: myAccs.length?myAccs.reduce((a,b)=>a+b,0)/myAccs.length:null,
    avgOppAccuracy: oppAccs.length?oppAccs.reduce((a,b)=>a+b,0)/oppAccs.length:null,
    myClassifications:myCls, oppClassifications:oppCls, myMoveTotal:myTotal,
    phases, conversion:{leadingN,leadingWins,losingN,losingSaves},
    topBlunders, tilt, byColor:{white:w,black:b},
    weekdayStats, hourStats, byTimeControl,
    competitivePlies: totalCompetitive, decidedPlies: totalDecided,
    conversionByPly: byPly,
    openingStats: computeOpeningStats(valid),
    oppStrengthStats: computeOppStrengthStats(valid),
    positionTypeStats: computePositionTypeStats(valid),
  };
}

// === New insight helpers ===========================================
function computeOpeningStats(valid){
  const map = new Map();
  for(const v of valid){
    const name = v.point.opening_name; if(!name) continue;
    if(!map.has(name)) map.set(name, {
      eco: v.point.opening_eco || '', name,
      n:0, wins:0, draws:0, losses:0,
      accSum:0, accN:0,
      asWhite:0, asBlack:0,
      lastBookPly:0, lastBookN:0,
    });
    const o = map.get(name);
    o.n++;
    if(v.persp.outcome==='Win') o.wins++;
    else if(v.persp.outcome==='Draw') o.draws++;
    else o.losses++;
    if(v.persp.meWhite) o.asWhite++; else o.asBlack++;
    if(v.analytics.accuracy.me != null){ o.accSum += v.analytics.accuracy.me; o.accN++; }
    if(v.point.opening_ply){ o.lastBookPly += v.point.opening_ply; o.lastBookN++; }
  }
  return map;
}
function computeOppStrengthStats(valid){
  const buckets = {
    weaker:   {label:'Opponent 100+ Elo weaker', n:0, wins:0, draws:0, losses:0, accSum:0, accN:0},
    similar:  {label:'Opponent within ±100 Elo', n:0, wins:0, draws:0, losses:0, accSum:0, accN:0},
    stronger: {label:'Opponent 100+ Elo stronger', n:0, wins:0, draws:0, losses:0, accSum:0, accN:0},
  };
  for(const v of valid){
    const my = v.persp.me && v.persp.me.rating, op = v.persp.opp && v.persp.opp.rating;
    if(!my || !op) continue;
    const delta = my - op;
    const b = delta > 100 ? buckets.weaker : delta < -100 ? buckets.stronger : buckets.similar;
    b.n++;
    if(v.persp.outcome==='Win') b.wins++;
    else if(v.persp.outcome==='Draw') b.draws++;
    else b.losses++;
    if(v.analytics.accuracy.me != null){ b.accSum += v.analytics.accuracy.me; b.accN++; }
  }
  return buckets;
}
function computePositionTypeStats(valid){
  // Per-ply accuracy bucketed by the eval BEFORE the move (from your POV).
  const buckets = [
    {key:'lost',     label:'Lost (≤−300)',          min:-Infinity, max:-300, accSum:0, accN:0, blun:0, plays:0},
    {key:'losing',   label:'Losing (−300..−100)',  min:-300, max:-100, accSum:0, accN:0, blun:0, plays:0},
    {key:'equal',    label:'Equal (−100..+100)',   min:-100, max:100,  accSum:0, accN:0, blun:0, plays:0},
    {key:'better',   label:'Better (+100..+300)',  min:100,  max:300,  accSum:0, accN:0, blun:0, plays:0},
    {key:'winning',  label:'Winning (≥+300)',       min:300,  max:Infinity, accSum:0, accN:0, blun:0, plays:0},
  ];
  for(const v of valid){
    const evals = v.point.evals || []; if(evals.length < 2) continue;
    const meWhite = v.persp.meWhite;
    const wins = evals.map(cp=>cpToWinPct(cp));
    for(let i=1; i<evals.length; i++){
      const whiteMoved = ((i-1)%2 === 0);
      const meMoved = (meWhite && whiteMoved) || (!meWhite && !whiteMoved);
      if(!meMoved) continue;
      const prev = evals[i-1];
      const myCp = meWhite ? prev : -prev;  // from your POV
      const b = buckets.find(x => myCp >= x.min && myCp < x.max);
      if(!b) continue;
      const cp = evals[i];
      const loss = whiteMoved ? Math.max(0, prev-cp) : Math.max(0, cp-prev);
      const acc = _moveAcc(wins[i-1], wins[i], meWhite);
      b.accSum += acc; b.accN++; b.plays++;
      if(loss >= CP_BLUNDER) b.blun++;
    }
  }
  return buckets;
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
  // --- Opening repertoire insights ---
  if(ins.openingStats && ins.openingStats.size){
    const ranked = [...ins.openingStats.values()].filter(o=>o.n>=3);
    if(ranked.length >= 2){
      const best  = [...ranked].sort((a,b)=> (b.wins/b.n) - (a.wins/a.n))[0];
      const worst = [...ranked].sort((a,b)=> (a.wins/a.n) - (b.wins/b.n))[0];
      if((best.wins/best.n) - (worst.wins/worst.n) > 0.25){
        n.push(`Best opening: ${best.name} (${(best.wins/best.n*100).toFixed(0)}% over ${best.n} games). Weakest: ${worst.name} (${(worst.wins/worst.n*100).toFixed(0)}% over ${worst.n}) — consider studying lines against this or avoiding it where you have transposition options.`);
      }
    }
  }
  // --- Opponent strength insights ---
  if(ins.oppStrengthStats){
    const o = ins.oppStrengthStats;
    if(o.stronger.n >= 5){
      const rate = o.stronger.wins/o.stronger.n*100;
      if(rate >= 35) n.push(`You hold your own vs higher-rated opponents (${rate.toFixed(0)}% over ${o.stronger.n} games at +100 Elo gap or more) — your ceiling is higher than your current rating suggests.`);
      else if(rate <= 20) n.push(`Stronger opponents are tough: ${rate.toFixed(0)}% in ${o.stronger.n} games vs +100 Elo or higher. Mostly an experience gap; pattern recognition catches up over time.`);
    }
    if(o.weaker.n >= 5){
      const rate = o.weaker.wins/o.weaker.n*100;
      if(rate <= 60) n.push(`You drop more games to weaker opponents than expected (${rate.toFixed(0)}% over ${o.weaker.n} games at −100 Elo gap or worse). Usually a focus/tilt issue — slow down vs opponents you "should" beat.`);
    }
    // Accuracy gap across buckets
    const accs = ['weaker','similar','stronger'].map(k=>({k, acc: o[k].accN ? o[k].accSum/o[k].accN : null, n: o[k].n})).filter(x=>x.acc!=null && x.n>=3);
    if(accs.length >= 2){
      const max = accs.reduce((a,b)=>a.acc>b.acc?a:b);
      const min = accs.reduce((a,b)=>a.acc<b.acc?a:b);
      if(max.acc - min.acc > 5){
        const labelMap = {weaker:'weaker opponents', similar:'peers', stronger:'stronger opponents'};
        n.push(`Accuracy swings by opponent strength: ${max.acc.toFixed(1)}% vs ${labelMap[max.k]} but only ${min.acc.toFixed(1)}% vs ${labelMap[min.k]} (Δ${(max.acc-min.acc).toFixed(1)}). ${min.k==='stronger'?'Expected — harder positions force harder choices.':min.k==='weaker'?'You may be coasting in easy games and missing tactics.':'Worth investigating.'}`);
      }
    }
  }
  // --- Position-type insights ---
  if(ins.positionTypeStats){
    const equal = ins.positionTypeStats.find(b=>b.key==='equal');
    const winning = ins.positionTypeStats.find(b=>b.key==='winning');
    const better = ins.positionTypeStats.find(b=>b.key==='better');
    const losing = ins.positionTypeStats.find(b=>b.key==='losing');
    if(equal && equal.accN >= 10){
      const eqAcc = equal.accSum/equal.accN;
      n.push(`Equal positions: ${eqAcc.toFixed(1)}% accuracy across ${equal.accN} moves. ${eqAcc<60?'Critical-moment decisions are your biggest leak — these are the moves that flip games.':eqAcc>75?'You handle complexity well; most losses come from elsewhere.':''}`);
    }
    if(winning && winning.accN >= 10 && better && better.accN >= 10){
      const winAcc = winning.accSum/winning.accN, betAcc = better.accSum/better.accN;
      if(winAcc - betAcc > 8){
        n.push(`Cleaner technique once you're clearly winning (${winAcc.toFixed(1)}% vs ${betAcc.toFixed(1)}% in slight-advantage positions) — you need to convert the slight edge to a big one before relaxing.`);
      } else if(winAcc - betAcc < -8){
        n.push(`You play slight-advantage positions sharper than fully-winning ones (${betAcc.toFixed(1)}% vs ${winAcc.toFixed(1)}%) — you may be relaxing once the position simplifies.`);
      }
    }
    if(losing && losing.accN >= 10){
      const losAcc = losing.accSum/losing.accN;
      if(losAcc > 75) n.push(`You defend losing positions well (${losAcc.toFixed(1)}% accuracy when down 1–3 pawns) — a sign of good resilience instinct.`);
    }
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
  const accNote = 'Lichess-style: volatility-weighted harmonic + arithmetic blend';
  const cards=[
    ['Your accuracy', fmtAcc(ins.avgMyAccuracy), accNote],
    ['Opp accuracy', fmtAcc(ins.avgOppAccuracy), accNote],
    ['Blunder rate', pct(cl.blunder,t), ''],
    ['Mistake rate', pct(cl.mistake,t), ''],
    ['Conversion (≥+2 @ 20)', c.leadingN?`${(c.leadingWins/c.leadingN*100).toFixed(0)}%  (${c.leadingWins}/${c.leadingN})`:'—', ''],
    ['Resilience (≤−2 @ 20)', c.losingN?`${(c.losingSaves/c.losingN*100).toFixed(0)}%  (${c.losingSaves}/${c.losingN})`:'—', ''],
    ['As white  W/D/L', w.n?`${w.wins}/${w.draws}/${w.losses}  ·  ${(w.wins/w.n*100).toFixed(0)}%`:'—', ''],
    ['As black  W/D/L', b.n?`${b.wins}/${b.draws}/${b.losses}  ·  ${(b.wins/b.n*100).toFixed(0)}%`:'—', ''],
  ];
  els.advancedKpis().innerHTML=cards.map(([k,v,note])=>`<div class='glass card'><div class='k'>${k}</div><div class='v' style='font-size:20px'>${v}</div>${note?`<div class='sub' style='font-size:10px;margin-top:2px'>${note}</div>`:''}</div>`).join('');
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
  // Plot conversion / resilience as lines across every ply, with the data
  // gated on a minimum sample size so noisy tail-of-game plies don't dominate.
  const MIN_SAMPLE = 3;
  const series = ins.conversionByPly || [];
  // Find the last ply where either bucket has data so we don't draw a giant
  // empty x-axis tail past where any game actually reached.
  let lastPly = 0;
  for(let p=1; p<series.length; p++){
    if(series[p].leadingN > 0 || series[p].losingN > 0) lastPly = p;
  }
  const labels = [];
  const conv = [];
  const res  = [];
  for(let p=1; p<=lastPly; p++){
    labels.push(p);
    const s = series[p];
    conv.push(s.leadingN >= MIN_SAMPLE ? (s.leadingWins/s.leadingN*100) : null);
    res .push(s.losingN  >= MIN_SAMPLE ? (s.losingSaves/s.losingN*100)   : null);
  }
  charts.conv?.destroy?.();
  charts.conv = new Chart(document.getElementById('conversionChart'),{
    type:'line',
    data:{labels, datasets:[
      {label:'Conversion %  (Win | ≥+2 at ply p)', data:conv, borderColor:'#1a7f37', backgroundColor:'rgba(26,127,55,.1)', tension:0.25, pointRadius:0, pointHoverRadius:3, spanGaps:true, borderWidth:1.8},
      {label:'Resilience %  (Save | ≤−2 at ply p)', data:res,  borderColor:'#175cd3', backgroundColor:'rgba(23,92,211,.1)', tension:0.25, pointRadius:0, pointHoverRadius:3, spanGaps:true, borderWidth:1.8, borderDash:[5,4]},
    ]},
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{title:{display:true,text:'Conversion & resilience throughout the game'},legend:{position:'bottom'}},
      interaction:{mode:'index',intersect:false},
      scales:{
        x:{title:{display:true,text:'Ply'}},
        y:{min:0,max:100,title:{display:true,text:'%'}},
      },
    },
  });
}
function drawPositionTypeChart(ins){
  const buckets = ins.positionTypeStats || [];
  const labels = buckets.map(b=>b.label);
  const accs = buckets.map(b => b.accN ? b.accSum/b.accN : null);
  const blun = buckets.map(b => b.plays ? (b.blun/b.plays*100) : null);
  charts.posType?.destroy?.();
  charts.posType = new Chart(document.getElementById('positionTypeChart'),{
    data:{labels, datasets:[
      {type:'bar',  label:'Accuracy %', data:accs, backgroundColor:'#0071e3', yAxisID:'yA', borderRadius:4},
      {type:'line', label:'Blunder rate %', data:blun, borderColor:'#b42318', backgroundColor:'rgba(180,35,24,.1)', tension:0.2, yAxisID:'yB'},
    ]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{title:{display:true,text:'How you play by position type (your moves only)'}, legend:{position:'top'}},
      scales:{
        yA:{type:'linear',position:'left',min:0,max:100,title:{display:true,text:'Accuracy %'}},
        yB:{type:'linear',position:'right',min:0,max:Math.max(30, Math.ceil(Math.max(...blun.filter(x=>x!=null),0)/5)*5),title:{display:true,text:'Blunder %'},grid:{drawOnChartArea:false}},
      },
    },
  });
}

function renderOpeningTable(ins){
  const m = ins.openingStats; const t = document.getElementById('openingTable'); if(!t) return;
  if(!m || !m.size){ t.innerHTML='<tr><td>No opening data yet</td></tr>'; return; }
  const MIN_GAMES = 3;
  const rows = [...m.values()].filter(o=>o.n>=MIN_GAMES).sort((a,b)=>b.n-a.n);
  if(!rows.length){
    t.innerHTML = `<tr><td>No opening with ≥${MIN_GAMES} games yet</td></tr>`;
  } else {
    const out = ['<tr><th>ECO</th><th>Opening</th><th>Games</th><th>W/D/L</th><th>Win %</th><th>Avg accuracy</th><th>Color split (W/B)</th></tr>'];
    for(const o of rows){
      const winRate = (o.wins/o.n*100).toFixed(0);
      const acc = o.accN ? (o.accSum/o.accN).toFixed(1)+'%' : '—';
      const winClass = (o.wins/o.n) >= 0.6 ? 'win' : (o.wins/o.n) <= 0.35 ? 'loss' : 'draw';
      out.push(`<tr><td>${o.eco||'—'}</td><td>${o.name}</td><td>${o.n}</td><td>${o.wins}/${o.draws}/${o.losses}</td><td class="${winClass}">${winRate}%</td><td>${acc}</td><td>${o.asWhite}/${o.asBlack}</td></tr>`);
    }
    t.innerHTML = out.join('');
  }
  // Top cards: best/worst openings (≥MIN_GAMES, by win rate)
  const ranked = [...m.values()].filter(o=>o.n>=MIN_GAMES);
  const host = document.getElementById('openingTopCards'); if(!host) return;
  if(ranked.length < 2){ host.innerHTML=''; return; }
  const best  = [...ranked].sort((a,b)=> (b.wins/b.n) - (a.wins/a.n))[0];
  const worst = [...ranked].sort((a,b)=> (a.wins/a.n) - (b.wins/b.n))[0];
  const mostPlayed = [...ranked].sort((a,b)=> b.n - a.n)[0];
  const card = (k, v, sub) => `<div class='glass card'><div class='k'>${k}</div><div class='v' style='font-size:16px'>${v}</div><div class='sub' style='font-size:11px;margin-top:4px'>${sub}</div></div>`;
  host.innerHTML = [
    card('Most played', mostPlayed.name, `${mostPlayed.n} games · ${(mostPlayed.wins/mostPlayed.n*100).toFixed(0)}% win`),
    card('Best results', best.name, `${best.n} games · ${(best.wins/best.n*100).toFixed(0)}% win · ${best.accN?(best.accSum/best.accN).toFixed(1)+'%':'—'} acc`),
    card('Worst results', worst.name, `${worst.n} games · ${(worst.wins/worst.n*100).toFixed(0)}% win · ${worst.accN?(worst.accSum/worst.accN).toFixed(1)+'%':'—'} acc`),
  ].join('');
}

function renderOpponentBuckets(ins){
  const b = ins.oppStrengthStats; const host = document.getElementById('opponentBuckets'); if(!host) return;
  if(!b || (b.weaker.n + b.similar.n + b.stronger.n === 0)){
    host.innerHTML = '<div class="sub" style="padding:14px">No opponent-rating data yet.</div>';
    return;
  }
  const card = (label, bucket) => {
    if(!bucket.n) return `<div class='glass card'><div class='k'>${label}</div><div class='v' style='font-size:16px;color:var(--muted)'>—</div><div class='sub' style='font-size:11px;margin-top:4px'>no games</div></div>`;
    const rate = (bucket.wins/bucket.n*100).toFixed(0);
    const acc  = bucket.accN ? (bucket.accSum/bucket.accN).toFixed(1)+'%' : '—';
    const winClass = (bucket.wins/bucket.n) >= 0.5 ? 'win' : (bucket.wins/bucket.n) <= 0.35 ? 'loss' : 'draw';
    return `<div class='glass card'><div class='k'>${label}</div><div class='v' style='font-size:22px' class='${winClass}'>${rate}% win</div><div class='sub' style='font-size:12px;margin-top:4px'>${bucket.wins}/${bucket.draws}/${bucket.losses} (${bucket.n} games) · ${acc} accuracy</div></div>`;
  };
  host.innerHTML = card(b.weaker.label, b.weaker) + card(b.similar.label, b.similar) + card(b.stronger.label, b.stronger);
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
    drawPositionTypeChart(ins);
    renderTimeControlTable(ins);
    renderOpeningTable(ins);
    renderOpponentBuckets(ins);
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
      const boardHost = document.getElementById('boardHost');
      boardHost.innerHTML = renderFenBoard(fen, flipBoard);
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
      // Build arrows. Played in blue, best in green; if the played move IS
      // the best move, draw only a single green arrow. On the last book
      // move, add a brown arrow showing what the next book continuation
      // would have been.
      const arrows = [];
      if(idx >= 1){
        const played = r.uci, bestU = r.best_uci;
        if(played && bestU && played.slice(0,4) === bestU.slice(0,4)){
          arrows.push({from:played.slice(0,2), to:played.slice(2,4), color:ARROW_COLORS.best, opacity:0.92, width:6});
        } else {
          if(played) arrows.push({from:played.slice(0,2), to:played.slice(2,4), color:ARROW_COLORS.played, opacity:0.8, width:5});
          if(bestU)  arrows.push({from:bestU.slice(0,2),  to:bestU.slice(2,4),  color:ARROW_COLORS.best,   opacity:0.92, width:5});
        }
        const opening = rows.opening;
        if(opening && opening.ply === idx && opening.next_uci){
          arrows.push({from:opening.next_uci.slice(0,2), to:opening.next_uci.slice(2,4), color:ARROW_COLORS.book, opacity:0.85, width:5});
        }
      }
      drawArrowsOnBoard(boardHost, arrows, flipBoard);

      updateEvalBar(cp, mate);
      updateChartHighlight();
      document.getElementById('plyMeta').textContent = `Ply ${idx}/${fens.length-1}`;

      // Classification badge + opening info
      const cls = classifyPlyMove(rows, idx, evals);
      const badge = renderClassBadge(cls);
      let openingHtml = '';
      const op = rows.opening;
      if(op && op.name){
        if(idx >= 1 && idx <= op.ply){
          const isLast = (idx === op.ply);
          const lastSuffix = isLast ? ` · <span style="color:#8b4513;font-weight:700">Last book move</span>${op.next_uci?' (brown arrow shows next book)':''}` : '';
          openingHtml = `<div class="sub" style="margin-top:6px;font-size:12px"><span style="color:#8b4513;font-weight:600">${op.eco?op.eco+' · ':''}${op.name}</span>${lastSuffix}</div>`;
        } else if(idx === op.ply + 1 && op.ply > 0){
          openingHtml = `<div class="sub" style="margin-top:6px;font-size:12px;color:var(--muted)">Out of book — was ${op.eco?op.eco+' · ':''}${op.name}</div>`;
        }
      }

      const evalLabel = mate!=null ? `M${Math.abs(mate)}` : (cp!=null ? cp : 'n/a');
      // Explanation block: only when the played move wasn't best/brilliant
      // (in which case both `played_reason` and `best_reason` are populated
      // by the backend). Layered as two short lines under the main ply
      // summary so it's easy to skim.
      let explainHtml = '';
      const showExplain = idx >= 1 && cls && cls !== 'book' && cls !== 'best' && cls !== 'brilliant' && (r.played_reason || r.best_reason);
      if(showExplain){
        const greenColor = '#2ea043', blueColor = '#1d6cf2';
        const bestLine   = r.best_reason   ? `<div style="margin:4px 0;font-size:12.5px;line-height:1.4"><span style="display:inline-block;min-width:16px;color:${greenColor};font-weight:700">▸</span><span style="color:var(--muted)">Best</span> <b>${r.best||'-'}</b> — <span style="color:var(--text)">${r.best_reason}</span></div>` : '';
        const playedLine = r.played_reason ? `<div style="margin:4px 0;font-size:12.5px;line-height:1.4"><span style="display:inline-block;min-width:16px;color:${blueColor};font-weight:700">▸</span><span style="color:var(--muted)">You played</span> <b>${r.move||'-'}</b> — <span style="color:var(--text)">${r.played_reason}</span></div>` : '';
        explainHtml = `<div style="margin-top:8px;padding:8px 10px;background:rgba(0,0,0,.03);border-left:3px solid #c8c8c8;border-radius:6px">${bestLine}${playedLine}</div>`;
      }
      if(idx === 0){
        document.getElementById('plyInfo').innerHTML = `<span class='sub'>Starting position. Eval: <b>${evalLabel}</b></span>${openingHtml}`;
      } else {
        document.getElementById('plyInfo').innerHTML = `${badge}Played: <b>${r.move||'-'}</b> | Eval: <b>${evalLabel}</b> | Best: <b>${r.best||'-'}</b> | Captured: <b>${cap||'none'}</b><br/><span class="sub" style="font-size:12px">PV: ${r.pv||'-'}</span>${explainHtml}${openingHtml}`;
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
            myAcc:null, oppAcc:null, evals:null,
            usedFallback:false, nullEvals:0, engineEvals:0, source:null};
  });
}
// Compute per-game accuracy (Lichess formula) from the eval array we already have.
function accFromEvals(evals, meWhite){
  if(!Array.isArray(evals) || evals.length < 2) return {me:null, opp:null};
  const ana = analyzeEvals(evals, meWhite);
  return ana ? {me: ana.accuracy.me, opp: ana.accuracy.opp} : {me:null, opp:null};
}
function applyBackendRowToPoint(point, beRec){
  if(!beRec) return;
  if(Array.isArray(beRec.evals) && beRec.evals.length) point.evals = beRec.evals;
  point.usedFallback = !!beRec.used_fallback;
  point.nullEvals = beRec.null_evals||0;
  point.engineEvals = beRec.engine_evals||0;
  point.source = beRec.has_analysis ? 'backend' : point.source;
  point.opening_eco = beRec.opening_eco || null;
  point.opening_name = beRec.opening_name || null;
  point.opening_ply = beRec.opening_ply || 0;
  if(point.evals && beRec.me_white !== undefined){
    const a = accFromEvals(point.evals, !!beRec.me_white);
    point.myAcc = a.me; point.oppAcc = a.opp;
  }
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
          points[i].evals=eng.evals;
          points[i].usedFallback=!!eng.usedFallback;
          points[i].nullEvals=eng.nullEvals||0;
          points[i].engineEvals=eng.engineEvals||0;
          points[i].source=eng.source||'local';
          const persp=perspective(filtered[i],user);
          const a=accFromEvals(points[i].evals, !!persp.meWhite);
          points[i].myAcc=a.me; points[i].oppAcc=a.opp;
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
    points[i].evals=eng.evals;
    points[i].usedFallback=!!eng.usedFallback;
    points[i].nullEvals=eng.nullEvals||0;
    points[i].engineEvals=eng.engineEvals||0;
    points[i].source=eng.source||'local';
    const persp=perspective(filtered[i],user);
    const a=accFromEvals(points[i].evals, !!persp.meWhite);
    points[i].myAcc=a.me; points[i].oppAcc=a.opp;
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
