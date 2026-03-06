/**
 * NUVO MNR TERMINAL v2.1 - MASTER STACK
 * 1. Serves the High-Density Dealer UI
 * 2. Fetches Live Market Data from Polygon.io
 * 3. Runs the Deterministic NMR v2.1 Math Engine
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- ROUTE 1: THE DATA API ---
    if (url.pathname.includes("/v1/nmr")) {
      const ticker = (url.searchParams.get("ticker") || "IREN").toUpperCase();
      const apiKey = env.POLYGON_API_KEY; 

      if (!apiKey) {
        return new Response(JSON.stringify({ error: "API Key Secret Missing in Cloudflare" }), { 
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      try {
        // Fetch Daily (300 bars) and Weekly (260 bars) for full structural appraisal
        const [dRes, wRes] = await Promise.all([
          fetch(`https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/day/2024-01-01/2026-12-31?adjusted=true&sort=desc&limit=300&apiKey=${apiKey}`),
          fetch(`https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/week/2021-01-01/2026-12-31?adjusted=true&sort=desc&limit=260&apiKey=${apiKey}`)
        ]);

        const dData = await dRes.json();
        const wData = await wRes.json();
        const daily = (dData.results || []).reverse();
        const weekly = (wData.results || []).reverse();

        if (daily.length < 50) throw new Error("Ticker history insufficient for appraisal.");

        // Run the NMR v2.1 Engine
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

    // --- ROUTE 2: THE UI (CATCH-ALL) ---
    return new Response(generateHTML(), {
      headers: { "Content-Type": "text/html" }
    });
  }
};

/** ── NMR v2.1 ENGINE ── **/
function runNMR(ticker, daily, weekly) {
  const dC = daily.map(b => b.c);
  const spot = dC[dC.length - 1];
  
  // Mean Engine (Daily)
  const sma21 = SMA(dC, 21);
  const sma50 = SMA(dC, 50); // Book Value
  const floor200d = SMA(dC, 200); // Institutional Floor
  
  // Structural Engine (5Y Weekly)
  const wH = Math.max(...weekly.map(b => b.h));
  const wL = Math.min(...weekly.map(b => b.l));
  const wR = wH - wL;

  const f382 = wH - (0.382 * wR);
  const f500 = wH - (0.500 * wR);
  const f618 = wH - (0.618 * wR);

  // Inventory Margin (IM) = (Book - Spot) / (Spot - Floor)
  const upside = sma50 - spot;
  const risk = spot - floor200d;
  const im = risk !== 0 ? upside / risk : 0;

  return {
    ticker, spot, sma21, sma50, floor200d,
    f382, f500, f618, im,
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
        .wrap { max-width: 1000px; margin: auto; }
        
        /* HEADER */
        .header { border: 1px solid var(--line); padding: 16px; margin-bottom: 16px; display: flex; justify-content: space-between; background: #050505; }
        h1 { margin:0; font-size: 22px; font-weight: 800; letter-spacing: -1.2px; }
        .red { color: var(--r); } .green { color: var(--g); } .orange { color: var(--o); } .blue { color: var(--b); } .mut { color: var(--mut); }
        .subtitle { color: var(--o); font-size: 9px; font-weight: 800; text-transform: uppercase; margin-top: 2px; letter-spacing: 1px; }
        .stamp { color: var(--mut); font-size: 10px; margin-top: 8px; }

        /* CONTROLS */
        .header-right { text-align: right; }
        .input-group { display: flex; gap: 6px; margin-bottom: 8px; }
        input { background: #000; border: 1px solid var(--line); color: var(--g); padding: 8px 12px; font-family: inherit; font-weight: 800; width: 90px; outline: none; text-transform: uppercase; }
        button { background: #fff; color: #000; border: none; padding: 8px 14px; font-family: inherit; font-weight: 800; cursor: pointer; text-transform: uppercase; font-size: 11px; }
        .header-anchors { font-size: 12px; font-weight: 800; }

        /* DIRECTIVE */
        .directive-box { border: 1px solid var(--o); padding: 12px 20px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center; background: rgba(255, 159, 28, 0.05); }
        .label { font-size: 9px; font-weight: 800; color: var(--mut); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 2px; }
        .badge { font-size: 20px; font-weight: 800; letter-spacing: -0.5px; }
        .spot-val { font-size: 24px; font-weight: 800; }

        /* GRID */
        .grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-bottom: 16px; }
        .panel { border: 1px solid var(--line); padding: 14px; background: #050505; }
        h3 { margin: 0 0 12px 0; font-size: 10px; color: var(--mut); border-bottom: 1px solid var(--line); padding-bottom: 6px; text-transform: uppercase; font-weight: 800; letter-spacing: 1px; }
        .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px dashed #161616; }
        .v { font-weight: 800; font-size: 15px; }

        /* IM SCORE SECTION */
        .im-section { display: flex; align-items: center; gap: 30px; padding: 24px; border: 1px solid var(--line); background: #080808; margin-top: 16px;}
        .im-val { font-size: 64px; font-weight: 800; color: var(--g); letter-spacing: -3px; line-height: 0.8; }
        .im-math { font-size: 11px; color: var(--mut); line-height: 1.6; }
        .im-math b { color: #fff; }

        #loader { display:none; color: var(--o); font-size: 10px; font-weight: 800; margin-bottom: 10px; }
    </style>
</head>
<body>
    <div class="wrap">
        <div class="header">
            <div>
                <h1><span class="red">NUVO</span> <span class="mut">MNR</span></h1>
                <div class="subtitle">NMR | NUVO MARKET REPORT v2.1</div>
                <div id="stamp" class="stamp">READY FOR SCAN</div>
            </div>
            <div class="header-right">
                <div class="input-group">
                    <input type="text" id="ticker" value="SOFI">
                    <button onclick="appraise()">APPRAISE</button>
                </div>
                <div id="hAnchors" class="header-anchors"></div>
            </div>
        </div>

        <div id="loader">SCANNING BARS... SYNCING LEDGER...</div>

        <div id="directiveBox" class="directive-box">
            <div>
                <div class="label">SYSTEM DIRECTIVE</div>
                <div id="badge" class="badge orange">AWAITING INPUT</div>
            </div>
            <div style="text-align:right">
                <div class="label">CURRENT SPOT</div>
                <div id="spot" class="spot-val">—</div>
            </div>
        </div>

        <div class="grid">
            <div class="panel">
                <h3>WHOLESALE BOX</h3>
                <div class="row"><span class="mut">Institutional Floor</span><span id="floorVal" class="v red">—</span></div>
                <div class="row"><span class="mut">Weekly FIB .618</span><span id="fib618" class="v red">—</span></div>
            </div>
            <div class="panel">
                <h3>RETAIL BOX</h3>
                <div class="row"><span class="mut">Book Value (50D)</span><span id="bookVal" class="v blue">—</span></div>
                <div class="row"><span class="mut">21D Supply Wall</span><span id="wallVal" class="v">—</span></div>
            </div>
            <div class="panel">
                <h3>STRUCTURAL STACK</h3>
                <div class="row"><span class="mut">Weekly FIB .382</span><span id="fib382" class="v green">—</span></div>
                <div class="row"><span class="mut">Weekly FIB .500</span><span id="fib500" class="v blue">—</span></div>
            </div>
        </div>

        <div class="im-section">
            <div>
                <div class="label">INVENTORY MARGIN (IM)</div>
                <div id="imVal" class="im-val">—</div>
            </div>
            <div class="im-math">
                <b>IM = (Supply - Spot) / (Spot - Floor)</b><br>
                <span id="verdict" class="green">SCAN REQUIRED</span>
            </div>
        </div>
    </div>

    <script>
        async function appraise() {
            const ticker = document.getElementById('ticker').value.toUpperCase();
            document.getElementById('loader').style.display = 'block';
            try {
                const res = await fetch(\`/v1/nmr?ticker=\${ticker}\`);
                const d = await res.json();
                if(d.error) throw new Error(d.error);

                document.getElementById('stamp').innerText = \`UNIT: \${d.ticker} | \${d.asof}\`;
                document.getElementById('spot').innerText = '$' + d.spot.toFixed(2);
                document.getElementById('floorVal').innerText = '$' + d.floor200d.toFixed(2);
                document.getElementById('fib618').innerText = '$' + d.f618.toFixed(2);
                document.getElementById('bookVal').innerText = '$' + d.sma50.toFixed(2);
                document.getElementById('wallVal').innerText = '$' + d.sma21.toFixed(2);
                document.getElementById('fib382').innerText = '$' + d.f382.toFixed(2);
                document.getElementById('fib500').innerText = '$' + d.f500.toFixed(2);
                document.getElementById('imVal').innerText = d.im.toFixed(2);
                
                document.getElementById('hAnchors').innerHTML = \`WHOLESALE: <span class="red">\${d.floor200d.toFixed(2)}</span> | RETAIL: <span class="blue">\${d.f500.toFixed(2)}</span>\`;

                const badge = document.getElementById('badge');
                const verdict = document.getElementById('verdict');
                if(d.im >= 1) { 
                    badge.innerText = "🟩 HIGH CONVICTION ACQUIRE"; badge.className = "badge green"; 
                    verdict.innerText = "VERDICT: LEDGER PASS - CONVICTION BUY"; verdict.className = "green";
                } else { 
                    badge.innerText = "🟧 WAIT / BID AT FLOOR"; badge.className = "badge orange"; 
                    verdict.innerText = "VERDICT: LEDGER LIMIT - BIDS ONLY"; verdict.className = "orange";
                }

            } catch(e) { alert("SCAN ERROR: " + e.message); }
            finally { document.getElementById('loader').style.display = 'none'; }
        }
        window.onload = appraise;
    </script>
</body>
</html>
  `;
}

function SMA(arr, n) { 
  const count = Math.min(arr.length, n);
  return arr.slice(-count).reduce((s,v)=>s+v,0)/count; 
}
