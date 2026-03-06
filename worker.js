/**
 * NUVO MNR TERMINAL v2.1 - MASTER STACK
 * High-Density Dealer Interface + Live Math Engine
 * Bulletproof Edition: Catch-all route to prevent 404s.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ROUTE 1: THE DATA API (Triggered by 'Appraise' button)
    if (url.pathname.includes("/v1/nmr")) {
      const ticker = (url.searchParams.get("ticker") || "IREN").toUpperCase();
      const apiKey = env.POLYGON_API_KEY; 

      if (!apiKey) {
        return new Response(JSON.stringify({ error: "API Key Not Found in Cloudflare Secrets" }), { 
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      try {
        // Fetch Daily (300 bars) and Weekly (260 bars) data from Polygon.io
        const dRes = await fetch(`https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/day/2024-01-01/2026-12-31?adjusted=true&sort=desc&limit=300&apiKey=${apiKey}`);
        const dData = await dRes.json();
        const daily = (dData.results || []).reverse();

        const wRes = await fetch(`https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/week/2021-01-01/2026-12-31?adjusted=true&sort=desc&limit=260&apiKey=${apiKey}`);
        const wData = await wRes.json();
        const weekly = (wData.results || []).reverse();

        if (daily.length < 100) throw new Error("Ticker history insufficient for appraisal.");

        // Execute NMR v2.1 Logic
        const report = runNMR(ticker, daily, weekly);
        
        return new Response(JSON.stringify(report), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { 
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    // ROUTE 2: THE UI (CATCH-ALL)
    // This forces the Terminal to show on every page to prevent 'Not Found' errors
    return new Response(generateHTML(), {
      headers: { "Content-Type": "text/html" }
    });
  }
};

/** ── NMR v2.1 MATH ENGINE ── **/
function runNMR(ticker, daily, weekly) {
  const dC = daily.map(b => b.c);
  const spot = dC[dC.length - 1];
  
  const sma21 = SMA(dC, 21);
  const sma50 = SMA(dC, 50); // Book Value
  const sma200 = SMA(dC, 200); // Institutional Floor
  
  const wH = Math.max(...weekly.map(b => b.h));
  const wL = Math.min(...weekly.map(b => b.l));
  const wR = wH - wL;

  return {
    ticker, spot, 
    sma21, sma50, sma200,
    f382: wH - (0.382 * wR), 
    f500: wH - (0.500 * wR), 
    f618: wH - (0.618 * wR),
    im: (sma50 - spot) / (spot - sma200 || 1),
    asof: new Date().toLocaleString()
  };
}

/** ── UI GENERATOR ── **/
function generateHTML() {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NUVO MNR TERMINAL</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;800&display=swap');
        :root { --bg: #000; --fg: #fff; --mut: #666; --line: #1a1a1a; --g: #00ff7f; --o: #ff9f1c; --r: #ff3b30; --b: #007aff; }
        body { background: var(--bg); color: var(--fg); font-family: "JetBrains Mono", monospace; margin: 0; padding: 16px; line-height: 1.4; font-size: 13px; }
        .wrap { max-width: 900px; margin: auto; }
        .header { border: 1px solid var(--line); padding: 16px; margin-bottom: 16px; display: flex; justify-content: space-between; background: #050505; }
        .red { color: var(--r); } .green { color: var(--g); } .orange { color: var(--o); } .blue { color: var(--b); } .mut { color: var(--mut); }
        .directive-box { border: 1px solid var(--o); padding: 12px 20px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center; background: rgba(255,159,28,0.05); }
        .panel { border: 1px solid var(--line); padding: 14px; background: #050505; margin-bottom: 16px; }
        .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px dashed #161616; }
        .v { font-weight: 800; font-size: 16px; }
        .im-val { font-size: 64px; font-weight: 800; color: var(--g); letter-spacing: -3px; }
        input { background: #000; border: 1px solid var(--line); color: var(--g); padding: 8px 12px; font-family: inherit; width: 90px; outline: none; text-transform: uppercase;}
        button { background: #fff; color: #000; border: none; padding: 8px 14px; font-weight: 800; cursor: pointer; }
        #loading { display:none; color: var(--o); font-size: 10px; margin-bottom: 10px; font-weight: 800; }
    </style>
</head>
<body>
    <div class="wrap">
        <div class="header">
            <div>
                <h1 style="margin:0; font-size:22px;"><span class="red">NUVO</span> <span class="mut">MNR</span></h1>
                <div style="font-size:9px; color:var(--o); font-weight:800;">NMR | NUVO MARKET REPORT v2.1</div>
                <div id="stamp" style="font-size:10px; color:var(--mut); margin-top:8px;">READY FOR SCAN</div>
            </div>
            <div style="text-align:right">
                <input type="text" id="ticker" value="IREN">
                <button onclick="run()">APPRAISE</button>
                <div id="hAnchors" style="font-size:11px; margin-top:8px; font-weight:800;"></div>
            </div>
        </div>

        <div id="loading">SCANNING POLYGON_API... SYNCING LEDGER...</div>

        <div id="content" style="display:none">
            <div class="directive-box">
                <div><div style="font-size:9px;" class="mut">SYSTEM DIRECTIVE</div><div id="badge" class="badge"></div></div>
                <div style="text-align:right"><div style="font-size:9px;" class="mut">CURRENT SPOT</div><div id="spot" class="v" style="font-size:24px">—</div></div>
            </div>

            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px;">
                <div class="panel">
                    <h3 style="font-size:10px; color:var(--mut); border-bottom:1px solid var(--line); padding-bottom:5px; margin:0 0 10px 0;">WHOLESALE BOX</h3>
                    <div class="row"><span class="mut">Institutional Floor</span><span id="wFloor" class="v red"></span></div>
                    <div class="row"><span class="mut">Weekly FIB .618</span><span id="f618" class="v red"></span></div>
                </div>
                <div class="panel">
                    <h3 style="font-size:10px; color:var(--mut); border-bottom:1px solid var(--line); padding-bottom:5px; margin:0 0 10px 0;">RETAIL BOX</h3>
                    <div class="row"><span class="mut">Book Value (50D)</span><span id="sma50" class="v blue"></span></div>
                    <div class="row"><span class="mut">21D Supply Wall</span><span id="sma21" class="v"></span></div>
                </div>
                <div class="panel">
                    <h3 style="font-size:10px; color:var(--mut); border-bottom:1px solid var(--line); padding-bottom:5px; margin:0 0 10px 0;">STRUCTURAL STACK</h3>
                    <div class="row"><span class="mut">Weekly FIB .382</span><span id="f382" class="v green"></span></div>
                    <div class="row"><span class="mut">Weekly FIB .500</span><span id="f500" class="v blue"></span></div>
                </div>
            </div>

            <div class="panel" style="display:flex; align-items:center; gap:30px; padding:24px; background:#080808;">
                <div><div style="font-size:9px;" class="mut">INVENTORY MARGIN (IM)</div><div id="im" class="im-val">—</div></div>
                <div style="font-size:11px;" class="mut">
                  <b>IM = (Supply - Spot) / (Spot - Floor)</b><br>
                  <span id="verdict" class="green"></span>
                </div>
            </div>
        </div>
    </div>

    <script>
        async function run() {
            const t = document.getElementById('ticker').value.toUpperCase();
            document.getElementById('loading').style.display = 'block';
            document.getElementById('content').style.display = 'none';
            try {
                const res = await fetch(\`/v1/nmr?ticker=\${t}\`);
                const d = await res.json();
                if(d.error) throw new Error(d.error);

                document.getElementById('stamp').innerText = \`UNIT: \${d.ticker} | \${d.asof}\`;
                document.getElementById('spot').innerText = '$' + d.spot.toFixed(2);
                document.getElementById('wFloor').innerText = '$' + d.sma200.toFixed(2);
                document.getElementById('f618').innerText = '$' + d.f618.toFixed(2);
                document.getElementById('sma50').innerText = '$' + d.sma50.toFixed(2);
                document.getElementById('sma21').innerText = '$' + d.sma21.toFixed(2);
                document.getElementById('f382').innerText = '$' + d.f382.toFixed(2);
                document.getElementById('f500').innerText = '$' + d.f500.toFixed(2);
                document.getElementById('im').innerText = d.im.toFixed(2);
                
                document.getElementById('hAnchors').innerHTML = \`WHOLESALE: <span class="red">\${d.sma200.toFixed(2)}</span> | RETAIL: <span class="blue">\${d.f500.toFixed(2)}</span>\`;

                const badge = document.getElementById('badge');
                if(d.im >= 1) { badge.innerText = "🟩 HIGH CONVICTION ACQUIRE"; badge.className = "badge green"; }
                else { badge.innerText = "🟧 WAIT / BID AT FLOOR"; badge.className = "badge orange"; }
                
                document.getElementById('verdict').innerText = d.im >= 1 ? "VERDICT: LEDGER PASS" : "VERDICT: LEDGER LIMIT";
                document.getElementById('content').style.display = 'block';
            } catch(e) { 
              alert("SCAN ERROR: " + e.message); 
            } finally { 
              document.getElementById('loading').style.display = 'none'; 
            }
        }
        window.onload = run;
    </script>
</body>
</html>
  `;
}

/** ── MATH UTILS ── **/
function SMA(a, n) { return a.slice(-n).reduce((s,v)=>s+v,0)/n; }
function EMA(a, n) { 
  const k = 2/(n+1); let e = a.slice(0,n).reduce((s,v)=>s+v,0)/n;
  for(let i=n; i<a.length; i++) e = a[i]*k + e*(1-k); return e;
}
