const BASE='https://api.chess.com/pub/player';
const charts={};
const DRAW_RESULTS=new Set(['agreed','repetition','stalemate','timevsinsufficient','insufficient','50move']);
const fmtPct=n=>`${(n*100).toFixed(1)}%`;
const daysAgoTs=d=>Math.floor((Date.now()-d*86400000)/1000);
const getFilterStart=f=>f==='24h'?daysAgoTs(1):f==='7d'?daysAgoTs(7):f==='30d'?daysAgoTs(30):f==='90d'?daysAgoTs(90):0;
const parseMoves=pgn=>(pgn||'').replace(/\{[^}]*\}|\([^)]*\)|\[[^\]]*\]|\d+\.(\.\.)?|\$\d+|1-0|0-1|1\/2-1\/2|\*/g,' ').trim().split(/\s+/).filter(Boolean);

const engine={w:null,ready:false,q:[],pending:null};
function initEngine(){if(engine.w) return;engine.w=new Worker('https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js');engine.w.onmessage=e=>onEngine(String(e.data||''));engine.w.postMessage('uci');engine.w.postMessage('isready');}
function onEngine(line){if(line==='readyok'){engine.ready=true;runNext();return;} if(!engine.pending) return; if(line.startsWith('info')&&line.includes(' score ')) engine.pending.last=line; if(line.startsWith('bestmove')){engine.pending.resolve(scoreFrom(engine.pending.last)); engine.pending=null; runNext();}}
function scoreFrom(info){if(!info) return 0;const m=info.match(/score (cp|mate) (-?\d+)/);if(!m)return 0; if(m[1]==='cp') return Math.max(-1000,Math.min(1000,Number(m[2]))); return Number(m[2])>0?1000:-1000;}
function runNext(){if(!engine.ready||engine.pending||!engine.q.length) return;engine.pending=engine.q.shift();engine.w.postMessage(`position fen ${engine.pending.fen}`);engine.w.postMessage(`go depth ${engine.pending.depth||8}`)}
function evalFen(fen,depth=8){initEngine();return new Promise(resolve=>{engine.q.push({fen,depth,resolve,last:''});runNext();});}

async function getJson(u){const r=await fetch(u);if(!r.ok) throw new Error(`HTTP ${r.status}: ${u}`);return r.json();}
async function loadData(user){const stats=await getJson(`${BASE}/${user}/stats`);const idx=await getJson(`${BASE}/${user}/games/archives`);const months=await Promise.all((idx.archives||[]).map(getJson));return {stats,games:months.flatMap(m=>m.games||[])};}
function perspective(g,u){const meWhite=g.white.username?.toLowerCase()===u.toLowerCase(),me=meWhite?g.white:g.black,opp=meWhite?g.black:g.white,res=me.result,outcome=res==='win'?'Win':(DRAW_RESULTS.has(res)?'Draw':'Loss');return {meWhite,me,opp,res,outcome};}

function filterGames(games,user,range,timeClass,limit){const start=getFilterStart(range);return games.filter(g=>g.rated&&g.time_class&&g.end_time>=start&&(timeClass==='all'||g.time_class===timeClass)&&((g.white.username||'').toLowerCase()===user.toLowerCase()||(g.black.username||'').toLowerCase()===user.toLowerCase())).sort((a,b)=>a.end_time-b.end_time).slice(-limit);}

async function evaluateGameQuick(g,user){const key=(g.url||'')+':d8';if(evalCache.has(key)) return evalCache.get(key);const chess=new Chess();const moves=parseMoves(g.pgn);let myLoss=0,oppLoss=0,myN=0,oppN=0;const {meWhite}=perspective(g,user);let prev=await evalFen(chess.fen(),8);
 for(let i=0;i<moves.length;i++){if(!chess.move(moves[i],{sloppy:true})) continue;const e=await evalFen(chess.fen(),8);const drop=Math.abs(e-prev);prev=e;const whiteMove=i%2===0;const meMoved=(meWhite&&whiteMove)||(!meWhite&&!whiteMove);if(meMoved){myLoss+=drop;myN++;}else{oppLoss+=drop;oppN++;}}
 const toElo=loss=>Math.max(400,Math.min(3000,2600-loss*3.2));
 const out={myEngineElo:toElo(myN?myLoss/myN:120),oppEngineElo:toElo(oppN?oppLoss/oppN:120)};evalCache.set(key,out);saveCache();return out;}

function saveCache(){localStorage.setItem('engineEvalCache',JSON.stringify([...evalCache.entries()]));}
function loadCache(){try{const raw=localStorage.getItem('engineEvalCache');if(raw){for(const [k,v] of JSON.parse(raw)) evalCache.set(k,v);}}catch{}}

function renderKpis(games){const wins=games.filter(g=>perspective(g,current.user).res==='win').length;const draws=games.filter(g=>DRAW_RESULTS.has(perspective(g,current.user).res)).length;const losses=games.length-wins-draws;
 const rows=[['Games in view',games.length],['W/D/L',`${wins}/${draws}/${losses}`],['Win rate',games.length?fmtPct(wins/games.length):'n/a'],['Engine cache hits',`${evalCache.size}`]];
 kpis.innerHTML=rows.map(([k,v])=>`<div class='glass card'><div class='k'>${k}</div><div class='v'>${v}</div></div>`).join('');}

function drawSkillGraph(points){charts.skill?.destroy?.();
 charts.skill=new Chart(document.getElementById('ratingChart'),{type:'line',data:{labels:points.map(p=>p.label),datasets:[{label:'Your Chess.com Elo',data:points.map(p=>p.myElo),borderColor:'#0071e3',tension:.2},{label:'Opponent Chess.com Elo',data:points.map(p=>p.oppElo),borderColor:'#8e8e93',tension:.2},{label:'Your Engine-Evaluated Elo',data:points.map(p=>p.myEng),borderColor:'#1a7f37',tension:.2},{label:'Opponent Engine-Evaluated Elo',data:points.map(p=>p.oppEng),borderColor:'#b42318',tension:.2}]},options:{plugins:{title:{display:true,text:'Skill Over Time: Chess.com Elo vs Engine-Evaluated Elo'}},scales:{x:{title:{display:true,text:'Games (chronological)'}},y:{title:{display:true,text:'Elo'}}}}});
}
function drawOpponentSpread(points){charts.opp?.destroy?.();charts.opp=new Chart(oppRatingChart,{type:'scatter',data:{datasets:[{label:'Your performance vs opponent skill',data:points.map(p=>({x:p.oppElo,y:p.myEng-p.oppEng})),backgroundColor:'#0071e3'}]},options:{plugins:{title:{display:true,text:'Engine Edge vs Opponent Chess.com Elo'}},scales:{x:{title:{display:true,text:'Opponent Chess.com Elo'}},y:{title:{display:true,text:'Engine Elo edge (you - opponent)'}}}}});}
function drawPlaceholder(canvasId,title){charts[canvasId]?.destroy?.();charts[canvasId]=new Chart(document.getElementById(canvasId),{type:'bar',data:{labels:['Use main graph'],datasets:[{label:title,data:[0]}]},options:{plugins:{legend:{display:false},title:{display:true,text:title}}}})}

function renderFeed(games,points){feedCount.textContent=`${games.length} games`;gamesFeed.innerHTML=games.map((g,i)=>{const p=perspective(g,current.user),e=points[i];const d=new Date(g.end_time*1000).toISOString().slice(0,10);return `<button class='game-row'><span>${d}</span><span>${g.time_class}</span><span>${p.me.username} (${p.me.rating}) vs ${p.opp.username} (${p.opp.rating})</span><span class='${p.outcome.toLowerCase()}'>${p.outcome}</span><span class='tag'>Eng ${Math.round(e.myEng)}/${Math.round(e.oppEng)}</span></button>`;}).join('')}


function updateProgressive(points, filtered, done, total){
  renderKpis(filtered);
  drawSkillGraph(points);
  drawOpponentSpread(points);
  drawPlaceholder('volumeChart','Game volume is represented by game count filter/time range');
  drawPlaceholder('resultChart','Use feed outcomes + W/D/L KPI');
  drawFeedDetails(points);
  renderFeed(filtered.slice(0, points.length), points);
  status.textContent = done < total
    ? `Engine-evaluating games ${done}/${total}... chart updates live.`
    : `Done. ${total} games plotted with Chess.com + engine Elo.`;
}

const evalCache=new Map();
const current={user:'',games:[]};
loadCache();

let runToken=0;
async function run(){const user=username.value.trim();const range=rangeFilter.value;const timeClass=timeClassFilter.value;const limit=Number(gameCountFilter.value)||100;const token=++runToken;status.textContent='Loading Chess.com data...';
 try{
  if(current.user!==user||!current.games.length){current.user=user;const loaded=await loadData(user);current.games=loaded.games;}
  const filtered=filterGames(current.games,user,range,timeClass,limit);
  const points=[];

  // Immediate first paint with Chess.com Elo only (engine Elo null until computed)
  for(let i=0;i<filtered.length;i++){
    const g=filtered[i],p=perspective(g,user);
    points.push({label:`${new Date(g.end_time*1000).toISOString().slice(0,10)} #${i+1}`,myElo:p.me.rating||null,oppElo:p.opp.rating||null,myEng:null,oppEng:null});
  }
  updateProgressive(points, filtered, 0, filtered.length);

  // Background progressive engine evaluation
  for(let i=0;i<filtered.length;i++){
    if(token!==runToken) return; // canceled by newer run
    const g=filtered[i],eng=await evaluateGameQuick(g,user);
    points[i].myEng=Math.round(eng.myEngineElo);
    points[i].oppEng=Math.round(eng.oppEngineElo);
    updateProgressive(points, filtered, i+1, filtered.length);
  }
 }catch(e){status.textContent=`Error: ${e.message}`;}
}

function drawFeedDetails(points){advancedKpis.innerHTML=`<div class='glass card'><div class='k'>Main graph meaning</div><div class='v' style='font-size:18px'>Blue: your Chess.com Elo · Gray: opponent Chess.com Elo · Green: your engine Elo · Red: opponent engine Elo</div></div>`;
 gameDetails.innerHTML=`<div class='sub'>This dashboard now prioritizes one useful graph: per-game Chess.com Elo and engine-estimated Elo for both players over time, with filters for timeframe, time class, and game count.</div>`;
 charts.accuracyTrendChart?.destroy?.();charts.phaseMistakeChart?.destroy?.();charts.weekdayChart?.destroy?.();charts.hourChart?.destroy?.();
}

loadBtn.addEventListener('click',run);rangeFilter.addEventListener('change',run);timeClassFilter.addEventListener('change',run);gameCountFilter.addEventListener('change',run);run();
