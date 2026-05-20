const BASE='https://api.chess.com/pub/player';
const charts={}, detailCharts={};
const DRAW_RESULTS=new Set(['agreed','repetition','stalemate','timevsinsufficient','insufficient','50move']);
const fmtPct=n=>`${(n*100).toFixed(1)}%`;
const daysAgoTs=d=>Math.floor((Date.now()-d*86400000)/1000);
const getFilterStart=f=>f==='24h'?daysAgoTs(1):f==='7d'?daysAgoTs(7):f==='30d'?daysAgoTs(30):f==='90d'?daysAgoTs(90):0;
const byMonthKey=t=>{const d=new Date(t*1000);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`};

const engine={w:null,ready:false,q:[],pending:null};
function initEngine(){if(engine.w) return;engine.w=new Worker('https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js');engine.w.onmessage=e=>onEngine(String(e.data||''));engine.w.postMessage('uci');engine.w.postMessage('isready');}
function onEngine(line){if(line==='readyok'){engine.ready=true;runNext();return;}if(!engine.pending) return;if(line.startsWith('info')&&line.includes(' score ')) engine.pending.last=line;if(line.startsWith('bestmove')){engine.pending.resolve(scoreFrom(engine.pending.last));engine.pending=null;runNext();}}
function scoreFrom(info){if(!info) return 0;const m=info.match(/score (cp|mate) (-?\d+)/);if(!m) return 0;if(m[1]==='cp') return Math.max(-1000,Math.min(1000,Number(m[2])));return Number(m[2])>0?1000:-1000;}
function runNext(){if(!engine.ready||engine.pending||!engine.q.length) return;engine.pending=engine.q.shift();engine.w.postMessage(`position fen ${engine.pending.fen}`);engine.w.postMessage('go depth 12');}
function evalFen(fen){initEngine();return new Promise(resolve=>{engine.q.push({fen,resolve,last:''});runNext();});}

async function getJson(u){const r=await fetch(u);if(!r.ok) throw new Error(`HTTP ${r.status}: ${u}`);return r.json();}
async function loadData(user){const stats=await getJson(`${BASE}/${user}/stats`);const idx=await getJson(`${BASE}/${user}/games/archives`);const months=await Promise.all((idx.archives||[]).map(getJson));return {stats,games:months.flatMap(m=>m.games||[])};}
const parseMoves=pgn=>(pgn||'').replace(/\{[^}]*\}|\([^)]*\)|\[[^\]]*\]|\d+\.(\.\.)?|\$\d+|1-0|0-1|1\/2-1\/2|\*/g,' ').trim().split(/\s+/).filter(Boolean);
function perspective(g,u){const meWhite=g.white.username?.toLowerCase()===u.toLowerCase(),me=meWhite?g.white:g.black,opp=meWhite?g.black:g.white,res=me.result,outcome=res==='win'?'Win':(DRAW_RESULTS.has(res)?'Draw':'Loss');return {meWhite,me,opp,res,outcome};}

function filterGames(games,user,range,timeClass){const start=getFilterStart(range);return games.filter(g=>g.rated&&g.time_class&&g.end_time>=start&&(timeClass==='all'||g.time_class===timeClass)&&((g.white.username||'').toLowerCase()===user.toLowerCase()|| (g.black.username||'').toLowerCase()===user.toLowerCase()));}

function analyze(stats,games,u){const groups={},months={},weekday=[0,0,0,0,0,0,0],hour=Array(24).fill(0);let wins=0,draws=0,losses=0,oppSum=0,mySum=0;
 for(const g of games){const {me,opp,res}=perspective(g,u);const tc=g.time_class,k=byMonthKey(g.end_time),d=new Date(g.end_time*1000);weekday[d.getUTCDay()]++;hour[d.getUTCHours()]++;oppSum+=opp.rating||0;mySum+=me.rating||0;
 if(!groups[tc]) groups[tc]={games:0,wins:0,draws:0,losses:0,my:0,opp:0};if(!months[k]) months[k]={games:0,w:0,d:0,l:0,my:0,opp:0,n:0};
 groups[tc].games++;groups[tc].my+=me.rating||0;groups[tc].opp+=opp.rating||0;months[k].games++;months[k].my+=me.rating||0;months[k].opp+=opp.rating||0;months[k].n++;
 if(res==='win'){wins++;groups[tc].wins++;months[k].w++;}else if(DRAW_RESULTS.has(res)){draws++;groups[tc].draws++;months[k].d++;}else{losses++;groups[tc].losses++;months[k].l++;}}
 Object.values(months).forEach(m=>{m.my/=m.n;m.opp/=m.n});
 return {total:games.length,wins,draws,losses,wr:games.length?wins/games.length:0,rapid:stats.chess_rapid?.last?.rating??null,blitz:stats.chess_blitz?.last?.rating??null,bullet:stats.chess_bullet?.last?.rating??null,avgMy:games.length?mySum/games.length:0,avgOpp:games.length?oppSum/games.length:0,groups,months,weekday,hour};}

function renderKPIs(a){const rows=[['Rated games',a.total],['W/D/L',`${a.wins}/${a.draws}/${a.losses}`],['Win rate',fmtPct(a.wr)],['Rapid',a.rapid??'n/a'],['Blitz',a.blitz??'n/a'],['Bullet',a.bullet??'n/a']];kpis.innerHTML=rows.map(([k,v])=>`<div class='card'><div class='k'>${k}</div><div class='v'>${v}</div></div>`).join('');}
function renderAdvanced(adv){const rows=[['Avg Accuracy',`${adv.acc.toFixed(1)}%`],['Best Move %',fmtPct(adv.bestPct)],['Blunder Rate',fmtPct(adv.blunPct)],['Opening Avg Loss',adv.openLoss.toFixed(1)],['Middlegame Avg Loss',adv.midLoss.toFixed(1)],['Endgame Avg Loss',adv.endLoss.toFixed(1)]];advancedKpis.innerHTML=rows.map(([k,v])=>`<div class='card'><div class='k'>${k}</div><div class='v'>${v}</div></div>`).join('');}
function drawMainCharts(a){const labels=Object.keys(a.months).sort(),my=labels.map(x=>a.months[x].my.toFixed(1)),opp=labels.map(x=>a.months[x].opp.toFixed(1)),games=labels.map(x=>a.months[x].games),w=labels.map(x=>a.months[x].w),d=labels.map(x=>a.months[x].d),l=labels.map(x=>a.months[x].l);
 for(const c of Object.values(charts)) c?.destroy?.();
 charts.rating=new Chart(ratingChart,{type:'line',data:{labels,datasets:[{label:'Your rating',data:my,borderColor:'#6ea8ff'},{label:'Opp rating',data:opp,borderColor:'#f9ae57'}]}});
 charts.volume=new Chart(volumeChart,{type:'bar',data:{labels,datasets:[{label:'Games',data:games,backgroundColor:'#6ea8ff'}]}});
 charts.result=new Chart(resultChart,{type:'line',data:{labels,datasets:[{label:'Wins',data:w,borderColor:'#5bd18b'},{label:'Draws',data:d,borderColor:'#ddd'},{label:'Losses',data:l,borderColor:'#ff7c8f'}]}});
 charts.opp=new Chart(oppRatingChart,{type:'line',data:{labels,datasets:[{label:'Opp strength',data:opp,borderColor:'#f9ae57'}]}});
 charts.weekday=new Chart(weekdayChart,{type:'bar',data:{labels:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],datasets:[{label:'Games by weekday (UTC)',data:a.weekday,backgroundColor:'#8bc8ff'}]}});
 charts.hour=new Chart(hourChart,{type:'line',data:{labels:Array.from({length:24},(_,i)=>String(i)),datasets:[{label:'Games by hour (UTC)',data:a.hour,borderColor:'#ffca5c'}]}});
}
function renderTimeControl(groups){const rows=Object.entries(groups).sort((a,b)=>b[1].games-a[1].games).map(([tc,g])=>`<tr><td>${tc}</td><td>${g.games}</td><td>${fmtPct(g.games?g.wins/g.games:0)}</td><td>${(g.my/g.games).toFixed(1)}</td><td>${(g.opp/g.games).toFixed(1)}</td></tr>`).join('');timeControlTable.innerHTML=`<thead><tr><th>Type</th><th>Games</th><th>Win rate</th><th>Your avg</th><th>Opp avg</th></tr></thead><tbody>${rows}</tbody>`;}

async function evaluateGame(g,user){const chess=new Chess();const moves=parseMoves(g.pgn),evals=[await evalFen(chess.fen())],rows=[];let myLoss=0,oppLoss=0,myN=0,oppN=0,best=0,inacc=0,mist=0,blun=0;let phase={open:0,mid:0,end:0},phaseN={open:0,mid:0,end:0};const {meWhite}=perspective(g,user);
 for(let i=0;i<moves.length;i++){const ok=chess.move(moves[i],{sloppy:true});if(!ok) continue;const e=await evalFen(chess.fen());const prev=evals[evals.length-1];evals.push(e);const drop=Math.abs(e-prev);const whiteMove=i%2===0,meMoved=(meWhite&&whiteMove)||(!meWhite&&!whiteMove);
 const cls=drop<35?'best':drop<90?'inacc':drop<180?'mist':'blun'; if(cls==='best')best++; if(cls==='inacc')inacc++; if(cls==='mist')mist++; if(cls==='blun')blun++;
 const phaseKey=i<20?'open':i<60?'mid':'end';phase[phaseKey]+=drop;phaseN[phaseKey]++;
 if(meMoved){myLoss+=drop;myN++;}else{oppLoss+=drop;oppN++;}
 rows.push({ply:i+1,san:moves[i],eval:e,drop,cls});document.getElementById('evalStatus').textContent=`Analyzed ${i+1}/${moves.length}`;}
 const toAcc=l=>Math.max(0,Math.min(100,100-l/18));
 const total=Math.max(rows.length,1);const summary={myAcc:toAcc(myN?myLoss/myN:0),oppAcc:toAcc(oppN?oppLoss/oppN:0),bestPct:best/total,blunPct:blun/total,openLoss:phaseN.open?phase.open/phaseN.open:0,midLoss:phaseN.mid?phase.mid/phaseN.mid:0,endLoss:phaseN.end?phase.end/phaseN.end:0,buckets:{best,inacc,mist,blun}};
 return {rows,evals,summary};
}
function drawDetailCharts(rows,evals){detailCharts.eval?.destroy?.();detailCharts.phase?.destroy?.();detailCharts.accuracy?.destroy?.();
 detailCharts.eval=new Chart(evalChart,{type:'line',data:{labels:evals.map((_,i)=>i),datasets:[{label:'Eval cp (White +)',data:evals,borderColor:'#6ea8ff'}]},options:{scales:{y:{min:-1000,max:1000}}}});
 detailCharts.phase=new Chart(phaseMistakeChart,{type:'bar',data:{labels:['Best','Inaccuracy','Mistake','Blunder'],datasets:[{label:'Move classification',data:[rows.filter(r=>r.cls==='best').length,rows.filter(r=>r.cls==='inacc').length,rows.filter(r=>r.cls==='mist').length,rows.filter(r=>r.cls==='blun').length],backgroundColor:['#5bd18b','#8bc8ff','#ffca5c','#ff7c8f']}]}});
}
function drawAccuracyTrend(history){charts.accTrend?.destroy?.();charts.accTrend=new Chart(accuracyTrendChart,{type:'line',data:{labels:history.map((_,i)=>i+1),datasets:[{label:'Your accuracy per analyzed game',data:history.map(h=>h.myAcc),borderColor:'#5bd18b'},{label:'Opponent accuracy',data:history.map(h=>h.oppAcc),borderColor:'#ff7c8f'}]}});}

function renderFeed(games,user){feedCount.textContent=`${games.length} games`;gamesFeed.innerHTML=games.slice().sort((a,b)=>b.end_time-a.end_time).map((g,idx)=>{const p=perspective(g,user),d=new Date(g.end_time*1000).toISOString().slice(0,10);return `<button class='game-row' data-idx='${idx}'><span>${d}</span><span>${g.time_class}</span><span>${p.me.username} (${p.me.rating}) vs ${p.opp.username} (${p.opp.rating})</span><span class='${p.outcome.toLowerCase()}'>${p.outcome}</span><span class='tag'>Analyze</span></button>`}).join('')||'<div class="sub">No games in this filter.</div>';
 const sorted=games.slice().sort((a,b)=>b.end_time-a.end_time);document.querySelectorAll('.game-row').forEach(b=>b.addEventListener('click',async()=>{const g=sorted[Number(b.dataset.idx)],p=perspective(g,user);
 gameDetails.innerHTML=`<h4>${p.outcome} • ${g.time_class} • ${new Date(g.end_time*1000).toUTCString()}</h4><div class='sub'>${p.me.username} (${p.me.rating}) vs ${p.opp.username} (${p.opp.rating})</div><div id='evalStatus' class='sub'>Running full engine eval...</div><p><a href='${g.url}' target='_blank' rel='noopener'>Open on Chess.com</a></p><canvas id='evalChart'></canvas><div id='quality' class='sub'></div><table><thead><tr><th>#</th><th>Move</th><th>Eval</th><th>ΔEval</th><th>Class</th></tr></thead><tbody id='movesT'></tbody></table>`;
 const out=await evaluateGame(g,user);accuracyHistory.push(out.summary);if(accuracyHistory.length>50) accuracyHistory.shift();drawAccuracyTrend(accuracyHistory);drawDetailCharts(out.rows,out.evals);quality.textContent=`Estimated engine accuracy — You: ${out.summary.myAcc.toFixed(1)}%, Opp: ${out.summary.oppAcc.toFixed(1)}% | Best: ${fmtPct(out.summary.bestPct)} | Blunders: ${fmtPct(out.summary.blunPct)}`;
 movesT.innerHTML=out.rows.map(r=>`<tr><td>${r.ply}</td><td>${r.san}</td><td>${r.eval}</td><td>${r.drop.toFixed(1)}</td><td class='${r.cls}'>${r.cls}</td></tr>`).join('');evalStatus.textContent='Engine eval complete.';
 const adv={acc:(out.summary.myAcc+out.summary.oppAcc)/2,bestPct:out.summary.bestPct,blunPct:out.summary.blunPct,openLoss:out.summary.openLoss,midLoss:out.summary.midLoss,endLoss:out.summary.endLoss};renderAdvanced(adv);
 }));}

let cache={user:null,stats:null,games:[]},accuracyHistory=[];
async function run(){const user=document.getElementById('username').value.trim(),range=rangeFilter.value,timeClass=timeClassFilter.value;status.textContent='Loading...';
 try{if(cache.user!==user||!cache.games.length) cache={user,...await loadData(user)};const filtered=filterGames(cache.games,user,range,timeClass);const a=analyze(cache.stats,filtered,user);
 renderKPIs(a);drawMainCharts(a);renderTimeControl(a.groups);renderFeed(filtered,user);status.textContent=`Loaded ${filtered.length} games for ${user}.`;
 advancedKpis.innerHTML='<div class="card"><div class="k">Advanced report</div><div class="v">Click a game to generate full engine-style analysis.</div></div>';
 }catch(e){status.textContent=`Error: ${e.message}`;}}
loadBtn.addEventListener('click',run);rangeFilter.addEventListener('change',run);timeClassFilter.addEventListener('change',run);run();
