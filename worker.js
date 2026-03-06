/**
 * NUVO MNR TERMINAL v2.5 - DEALER EDITION
 * Full High-Density UI + Structural Math Engine
 * FIXED: EMA variable typo & IM below-floor logic
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- ROUTE 1: THE DATA API ---
    if (url.pathname.includes("/v1/nmr")) {
      const ticker = (url.searchParams.get("ticker") || "IREN").toUpperCase();
      const apiKey = env.POLYGON_API_KEY; 

      if (!apiKey) return new Response(JSON.stringify({ error: "Missing API Key" }), { 
        status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } 
      });

      try {
        const [dRes, wRes] = await Promise.all([
          fetch(`https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/day/2024-01-01/2026-12-31?adjusted=true&sort=desc&limit=300&apiKey=${apiKey}`),
          fetch(`https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/week/2021-01-01/2026-12-31?adjusted=true&sort=desc&limit=260&apiKey=${apiKey}`)
        ]);

        const dData = await dRes.json();
        const wData = await wRes.json();
        const daily = (dData.results || []).reverse();
        const weekly = (wData.results || []).reverse();

        if (daily.length < 100) throw new Error("Ticker history insufficient.");

        // Execute NMR v2.5 Math
        const report = runNMR(ticker, daily, weekly);
        
        return new Response(JSON.stringify(report), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // --- ROUTE 2: THE UI (CATCH-ALL) ---
    return new Response(generateHTML(), { headers: { "Content-Type": "text/html" } });
  }
};

/** ── NMR v2.5 ENGINE ── **/
function runNMR(ticker, daily, weekly) {
  const dC = daily.map(b => b.c);
  const spot = dC[dC.length - 1];
  
  const sma21 = SMA(dC, 21);
  const sma50 = SMA(dC, 50); // Book Value
  const floor200d = SMA(dC, 200); // Institutional Floor
  
  const wH = Math.max(...weekly.map(b => b.h));
  const wL = Math.min(...weekly.map(b => b.l));
  const wR = wH - wL;

  const f382 = wH - (0.382 * wR);
  const f500 = wH - (0.500 * wR);
  const f618 = wH - (0.618 * wR);

  // Inventory Margin (IM) Logic
  // If price is below floor, IM is maxed out (Dealer Pass)
  const upside = sma50 - spot;
  const risk = spot - floor200d;
  const im = risk > 0 ? upside / risk : 9.99; 

  return {
    ticker, spot, sma21, sma50, floor200d,
    f382, f500, f618, im,
    asof: new Date().toLocaleString()
  };
}

/** ── HIGH-DENSITY UI GENERATOR ── **/
function generateHTML() {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NUVO MNR | DEALER TERMINAL</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;800&display=swap');
        
        :root {
            --bg: #000000;
            --fg: #ffffff;
            --mut: #666666;
            --line: #1a1a1a;
            --g: #00ff7f; 
            --o: #ff9f1c; 
            --r: #ff3b30; 
            --b: #007aff; 
            --p: #080808; 
        }

        * { box-sizing: border-box; }
        body { 
            background: var(--bg); 
            color: var(--fg); 
            font-family: "JetBrains Mono", monospace; 
            margin: 0; 
            padding: 24px; 
            font-size: 13px; 
            letter-spacing: -0.2px;
        }

        .container { max-width: 1100px; margin: auto; }

        .top-bar { 
            display: flex; 
            justify-content: space-between; 
            align-items: flex-start; 
            border-bottom: 2px solid var(--line);
            padding-bottom: 24px;
            margin-bottom: 32px;
        }

        .brand h1 { margin: 0; font-size: 28px; font-weight: 800; letter-spacing: -1.5px; }
        .brand .tag { color: var(--o); font-size: 10px; font-weight: 800; text-transform: uppercase; margin-top: 4px; letter-spacing: 1px; }
        
        .controls { text-align: right; }
        .search-row { display: flex; gap: 8px; margin-bottom: 12px; }
        input { background: #000; border: 1px solid var(--line); color: var(--g); padding: 10px 14px; font-family: inherit; font-weight: 800; width: 110px; outline: none; font-size: 14px; }
        button { background: #fff; color: #000; border: none; padding: 10px 20px; font-family: inherit; font-weight: 800; cursor: pointer; text-transform: uppercase; font-size: 12px; transition: opacity 0.2s; }
        .anchors { font-size: 11px; font-weight: 800; text-transform: uppercase; color: var(--mut); }

        .directive-box { 
            border: 1px solid var(--o); 
            padding: 20px 30px; 
            margin-bottom: 24px; 
            display: flex; 
            justify-content: space-between; 
            align-items: center; 
            background: linear-gradient(90deg, rgba(255,159,28,0.08) 0%, rgba(0,0,0,0) 100%);
        }
        .label { font-size: 9px; font-weight: 800; color: var(--mut); text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 6px; }
        .badge { font-size: 24px; font-weight: 800; letter-spacing: -0.8px; }
        .spot-display { text-align: right; }
        .spot-price { font-size: 36px; font-weight: 800; letter-spacing: -1px; }

        .dashboard-grid { 
            display: grid; 
            grid-template-columns: repeat(3, 1fr); 
            gap: 20px; 
            margin-bottom: 24px;
        }
        .panel { 
            border: 1px solid var(--line); 
            padding: 20px; 
            background: var(--p);
            position: relative;
            overflow: hidden;
        }
        .panel h3 { 
            margin: 0 0 16px 0; 
            font-size: 11px; 
            color: var(--mut); 
            border-bottom: 1px solid var(--line); 
            padding-bottom: 8px; 
            text-transform: uppercase; 
            font-weight: 800;
            letter-spacing: 1px;
        }
        .data-row { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px dashed #161616; }
        .val { font-weight: 800; font-size: 18px; }

        .im-footer { 
            display: grid; 
            grid-template-columns: 280px 1fr; 
            gap: 40px; 
            padding: 40px; 
            border: 1px solid var(--line); 
            background: #050505; 
            align-items: center;
        }
        .im-score-wrap { text-align: left; }
        .im-number { font-size: 84px; font-weight: 800; letter-spacing: -5px; line-height: 0.8; }
        .im-verdict-box { border-left: 1px solid var(--line); padding-left: 40px; }
        .im-math-formula { font-size: 12px; color: var(--mut); margin-bottom: 15px; line-height: 1.6; }
        .im-math-formula b { color: #fff; }
        .verdict-text { font-size: 18px; font-weight: 800; text-transform: uppercase; }

        .red { color: var(--r); } .green { color: var(--g); } .orange { color: var(--o); } .blue { color: var(--b); }

        #loader { 
            display:none; 
            position: fixed; top: 0; left: 0; width: 100%; height: 2px; 
            background: var(--o); z-index: 1000;
            animation: pulse 1.5s infinite;
        }
        @keyframes pulse { 0% { opacity: 0.2; } 50% { opacity: 1; } 100% { opacity: 0.2; } }

        @media (max-width: 900px) {
            .dashboard-grid { grid-template-columns: 1fr; }
            .im-footer { grid-template-columns: 1fr; padding: 20px; }
            .im-number { font-size: 60px; }
            .im-verdict-box { border-left: none; padding-left: 0; padding-top: 20px; border-top: 1px solid var(--line); }
        }
    </style>
</head>
<body>
    <div id="loader"></div>
    
    <div class="container">
        <div class="top-bar">
            <div class="brand">
                <h1><span class="red">NUVO</span> <span class="mut">MNR</span></h1>
                <div class="tag">DEALER TERMINAL v2.5 // QUANT ENGINE</div>
                <div id="unit-stamp" style="color:var(--mut); font-size:10px; margin-top:10px;">AWAITING SIGNAL...</div>
            </div>
            <div class="controls">
                <div class="search-row">
                    <input type="text" id="tickerInput" value="IREN" placeholder="TICKER">
                    <button onclick="appraise()">APPRAISE</button>
                </div>
                <div id="hAnchors" class="anchors"></div>
            </div>
        </div>

        <div class="directive-box">
            <div>
                <div class="label">SYSTEM DIRECTIVE</div>
                <div id="badge" class="badge orange">INITIALIZING LEDGER...</div>
            </div>
            <div class="spot-display">
                <div class="label">CURRENT SPOT PRICE</div>
                <div id="spotVal" class="spot-price">—</div>
            </div>
        </div>

        <div class="dashboard-grid">
            <div class="panel">
                <h3>WHOLESALE BOX [INSTITUTIONAL]</h3>
                <div class="data-row">
                    <span class="mut">Floor (200D SMA)</span>
                    <span id="floorVal" class="val red">—</span>
                </div>
                <div class="data-row">
                    <span class="mut">Weekly FIB .618</span>
                    <span id="f618" class="val red">—</span>
                </div>
                <div style="font-size:9px; color:var(--mut); margin-top:15px; text-transform:uppercase;">Entry Zone: Below Floor</div>
            </div>

            <div class="panel">
                <h3>RETAIL BOX [FAIR VALUE]</h3>
                <div class="data-row">
                    <span class="mut">Book Value (50D SMA)</span>
                    <span id="bookVal" class="val blue">—</span>
                </div>
                <div class="data-row">
                    <span class="mut">Supply Wall (21D SMA)</span>
                    <span id="wallVal" class="val">—</span>
                </div>
                <div style="font-size:9px; color:var(--mut); margin-top:15px; text-transform:uppercase;">Market Mean: Book Value</div>
            </div>

            <div class="panel">
                <h3>STRUCTURAL LADDER [FIB]</h3>
                <div class="data-row">
                    <span class="mut">Weekly FIB .500</span>
                    <span id="f500" class="val blue">—</span>
                </div>
                <div class="data-row">
                    <span class="mut">Weekly FIB .382</span>
                    <span id="f382" class="val green">—</span>
                </div>
                <div style="font-size:9px; color:var(--mut); margin-top:15px; text-transform:uppercase;">Expansion Threshold: .382</div>
            </div>
        </div>

        <div class="im-footer">
            <div class="im-score-wrap">
                <div class="label">INVENTORY MARGIN (IM)</div>
                <div id="imScore" class="im-number">—</div>
            </div>
            <div class="im-verdict-box">
                <div class="im-math-formula">
                    <b>IM FORMULA:</b> (Book Value - Spot) / (Spot - Floor)<br>
                    Logic: Measuring potential yield vs. institutional risk floor.
                </div>
                <div id="verdictText" class="verdict-text green">READY FOR SCAN</div>
            </div>
        </div>
    </div>

    <script>
        async function appraise() {
            const tickerInput = document.getElementById('tickerInput');
            const ticker = tickerInput.value.toUpperCase();
            document.getElementById('loader').style.display = 'block';
            
            try {
                const res = await fetch(\`/v1/nmr?ticker=\${ticker}\`);
                const d = await res.json();
                if(d.error) throw new Error(d.error);

                document.getElementById('unit-stamp').innerText = \`UNIT: \${d.ticker} | LEDGER SYNC: \${d.asof}\`;
                document.getElementById('spotVal').innerText = \`$\${d.spot.toFixed(2)}\`;
                document.getElementById('hAnchors').innerHTML = \`WHOLESALE: <span class="red">\$\${d.floor200d.toFixed(2)}</span> | RETAIL: <span class="blue">\$\${d.f500.toFixed(2)}</span>\`;

                document.getElementById('floorVal').innerText = '$' + d.floor200d.toFixed(2);
                document.getElementById('f618').innerText = '$' + d.f618.toFixed(2);
                document.getElementById('bookVal').innerText = '$' + d.sma50.toFixed(2);
                document.getElementById('wallVal').innerText = '$' + d.sma21.toFixed(2);
                document.getElementById('f382').innerText = '$' + d.f382.toFixed(2);
                document.getElementById('f500').innerText = '$' + d.f500.toFixed(2);
                
                const im = d.im;
                const imEl = document.getElementById('imScore');
                imEl.innerText = im >= 9.99 ? "MAX" : im.toFixed(2);
                
                const badge = document.getElementById('badge');
                const verdict = document.getElementById('verdictText');

                if (im >= 1.0) {
                    imEl.className = 'im-number green';
                    badge.innerText = "🟩 HIGH CONVICTION ACQUIRE";
                    badge.className = "badge green";
                    verdict.innerText = "VERDICT: LEDGER PASS - CONVICTION BUY ZONE";
                    verdict.className = "verdict-text green";
                } else if (im > 0 && im < 1.0) {
                    imEl.className = 'im-number orange';
                    badge.innerText = "🟧 EQUILIBRIUM / HOLD";
                    badge.className = "badge orange";
                    verdict.innerText = "VERDICT: LEDGER LIMIT - AWAIT WHOLESALE PULLBACK";
                    verdict.className = "verdict-text orange";
                } else {
                    imEl.className = 'im-number red';
                    badge.innerText = "🟥 RISK OVER EXTENSION";
                    badge.className = "badge red";
                    verdict.innerText = "VERDICT: OVERBOUGHT - DISTRIBUTION DETECTED";
                    verdict.className = "verdict-text red";
                }

            } catch(e) { 
                alert("TERMINAL ERROR: " + e.message); 
            } finally { 
                document.getElementById('loader').style.display = 'none'; 
            }
        }
        window.onload = appraise;
    </script>
</body>
</html>
  `;
}

function SMA(a, n) { 
  const count = Math.min(a.length, n);
  return a.slice(-count).reduce((s,v)=>s+v,0)/count; 
}

function EMA(a, n) { 
  if (a.length < n) return a[a.length - 1] || 0;
  const k = 2/(n+1); 
  let e = a.slice(0,n).reduce((s,v)=>s+v,0)/n;
  for(let i=n; i<a.length; i++) e = a[i] * k + e * (1 - k); 
  return e;
}
