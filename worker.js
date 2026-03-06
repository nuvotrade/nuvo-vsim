<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NUVO MNR — IREN APPRAISAL</title>

<style>
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;800&display=swap');

:root {
  --bg: #000;
  --fg: #fff;
  --mut: #666;
  --line: #1a1a1a;
  --g: #00ff7f;
  --o: #ff9f1c;
  --r: #ff3b30;
  --b: #007aff;
}

* { box-sizing: border-box; }

body {
  background: var(--bg);
  color: var(--fg);
  font-family: "JetBrains Mono", monospace;
  margin: 0;
  padding: 16px; 
  line-height: 1.4; 
}

.wrap { max-width: 1000px; margin: auto; } 

/* HEADER SECTION */
.header {
  border: 1px solid var(--line);
  padding: 16px; 
  margin-bottom: 16px;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  background: linear-gradient(to bottom, #050505, #000);
}

.title-group h1 { margin: 0; font-size: 22px; font-weight: 800; letter-spacing: -1.2px; } 
.subtitle { color: var(--o); font-size: 9px; font-weight: 800; tracking-widest: 1.5px; text-transform: uppercase; margin-top: 2px; }
.stamp { color: var(--mut); font-size: 10px; margin-top: 10px; white-space: pre-line; }

/* CONTROLS AREA */
.controls-area {
  text-align: right;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.input-group {
  display: flex;
  gap: 6px;
}

input {
  background: #000;
  border: 1px solid var(--line);
  color: var(--g); 
  padding: 8px 12px; 
  font-family: inherit;
  font-weight: 800;
  font-size: 12px;
  width: 90px; 
  outline: none;
  text-transform: uppercase;
}

button {
  background: #fff;
  color: #000;
  border: none;
  padding: 8px 14px;
  font-family: inherit;
  font-weight: 800;
  font-size: 11px; 
  cursor: pointer;
  text-transform: uppercase;
}

/* IM MATH / HEADER DETAILS */
.im-math { font-size: 10px; color: var(--mut); line-height: 1.6; }
.header-anchor { font-size: 12px; font-weight: 800; letter-spacing: 0.2px; }

/* DIRECTIVE BOX */
.directive-box {
  border: 1px solid var(--o);
  padding: 10px 20px; 
  margin-bottom: 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: rgba(255, 159, 28, 0.05);
}

.directive-label { font-size: 9px; font-weight: 800; color: var(--mut); margin-bottom: 1px; text-transform: uppercase; letter-spacing: 1px; }
.badge { font-size: 20px; font-weight: 800; color: var(--o); letter-spacing: -0.5px; } 
.spot-display { text-align: right; }
.spot-val { font-size: 24px; font-weight: 800; line-height: 1; } 

/* GRID LAYOUT */
.grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-bottom: 16px; align-items: start; }

.panel { border: 1px solid var(--line); padding: 14px; background: #050505; margin-bottom: 16px; }
.panel:last-child { margin-bottom: 0; }
.panel h3 { 
  margin: 0 0 12px 0; 
  font-size: 10px; 
  font-weight: 800; 
  color: var(--mut); 
  border-bottom: 1px solid var(--line); 
  padding-bottom: 6px; 
  letter-spacing: 1px;
}

.sub-h { font-size: 9px; color: var(--mut); text-transform: uppercase; font-weight: 800; margin-top: 14px; border-bottom: 1px solid #111; padding-bottom: 4px; }

.row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px dashed #161616; font-size: 13px; } 
.row:last-child { border-bottom: none; }
.k { color: var(--mut); }
.v { text-align: right; font-weight: 800; font-size: 15px; } 

/* EXECUTION TABLE */
.exec-box { border: 1px solid var(--line); padding: 16px; margin-bottom: 0; }
.exec-table { width: 100%; border-collapse: collapse; margin-top: 8px; }
.exec-table th { text-align: left; font-size: 9px; color: var(--mut); padding-bottom: 8px; border-bottom: 1px solid var(--line); text-transform: uppercase; }
.exec-table td { padding: 12px 0; border-bottom: 1px dashed #161616; vertical-align: top; }
.action-cell { font-weight: 800; font-size: 13px; width: 180px; }
.lvl-cell { font-weight: 800; color: var(--g); font-size: 16px; width: 160px; line-height: 1.2; } 
.interp-cell { font-size: 11px; color: var(--mut); line-height: 1.4; padding-left: 14px; }

/* IM SCORE LARGE (AT VERY BOTTOM) */
.im-section {
  display: flex;
  align-items: center;
  gap: 30px;
  padding: 20px; 
  border: 1px solid var(--line);
  margin-top: 16px;
  background: linear-gradient(90deg, #080808, #000);
}

.im-val { font-size: 64px; font-weight: 800; color: var(--g); line-height: 0.8; letter-spacing: -3px; } 
.im-math { font-size: 10px; color: var(--mut); line-height: 1.8; }
.im-math b { color: #fff; font-size: 12px; }

/* ALERTS */
.orange-text { color: var(--o); }
.green-text { color: var(--g); }
.red-text { color: var(--r); }
.blue-text { color: var(--b); }

@media (max-width: 900px) {
  .grid { grid-template-columns: 1fr; }
  .im-section { flex-direction: column; align-items: flex-start; gap: 15px; }
}
</style>
</head>

<body>
<div class="wrap">

  <!-- HEADER -->
  <div class="header">
    <div class="title-group">
      <h1><span class="red-text">NUVO</span> <span style="color: var(--mut);">MNR</span></h1>
      <div class="subtitle">NMR | NUVO MARKET REPORT v2.1</div>
      <div class="stamp">
        UNIT: IREN (IRIS ENERGY LTD)
        DATE: 2026-03-06
        APPRAISAL: DETERMINISTIC_MATH_LOCKED
      </div>
    </div>
    
    <div class="controls-area">
      <div class="input-group">
        <input type="text" id="tickerInput" value="IREN" placeholder="TICKER">
        <button onclick="window.location.reload()">APPRAISE</button>
      </div>
      <div class="im-math">
        SYSTEM_ID: NMR-VERIFIED-4013<br>
        LOT_STATUS: <span class="orange-text">RESTRICTED_BIDS_ONLY</span><br>
        <div class="header-anchor" style="margin-top:4px;">
          WHOLESALE: <span class="red-text">36.00</span> | RETAIL: <span class="blue-text">41.00</span>
        </div>
      </div>
    </div>
  </div>

  <!-- DIRECTIVE BOX (SLIMMED DOWN) -->
  <div class="directive-box">
    <div>
      <div class="directive-label">SYSTEM DIRECTIVE</div>
      <div class="badge">🟧 ORANGE — WAIT / BID AT FLOOR</div>
    </div>
    <div class="spot-display">
      <div class="directive-label">CURRENT SPOT</div>
      <div class="spot-val">$40.13</div>
    </div>
  </div>

  <!-- MAIN BOXES -->
  <div class="grid">
    <!-- COLUMN 1: WHOLESALE -->
    <div class="panel">
      <h3>WHOLESALE BOX (ACQUISITION)</h3>
      <div class="row">
        <span class="k">NMR Wholesale Range</span>
        <span class="v red-text">$32.53 – $36.09</span>
      </div>
      <div class="row">
        <span class="k">AVG NMR VALUE (Floor)</span>
        <span class="v red-text">$36.09</span>
      </div>
      <div class="row">
        <span class="k">LOW MNR VALUE (Deep)</span>
        <span class="v red-text">$32.53</span>
      </div>
      <div class="row">
        <span class="k">Salvage Floor (52W Low)</span>
        <span class="v">$5.13</span>
      </div>
      <div class="stamp" style="margin-top:15px;">
        Institutional clearing band anchored to 200D SMA and 61.8% Structural Fibonacci.
      </div>
    </div>

    <!-- COLUMN 2: RETAIL BOX -->
    <div class="panel">
      <h3>RETAIL BOX (LEASING)</h3>
      <div class="row">
        <span class="k">21-Day Market Supply</span>
        <span class="v">$42.12</span>
      </div>
      <div class="row">
        <span class="k">50-Day Market Supply</span>
        <span class="v blue-text">$46.36</span>
      </div>
      <div class="row">
        <span class="k">RETAIL VALUE (50% Fib)</span>
        <span class="v">$41.00</span>
      </div>
      <div class="row">
        <span class="k">Cushion to Floor</span>
        <span class="v orange-text">$4.04 (10.1%)</span>
      </div>
      <div class="stamp" style="margin-top:15px;">
        Overhead supply corridors. Unit remains under-supplied until reclaiming $46.36 mean.
      </div>
    </div>

    <!-- COLUMN 3: MARKET GAUGE & STRUCTURAL STACK -->
    <div class="grid-column">
      <div class="panel">
        <h3>MARKET GAUGE (DAILY PULSE)</h3>
        <div class="row">
          <span class="k">RSI (14) [DAILY]</span>
          <span class="v orange-text">41.48 (NEUTRAL)</span>
        </div>
        <div class="row">
          <span class="k">MACD (12, 26) [DAILY]</span>
          <span class="v orange-text">-0.67 (NEUTRAL)</span>
        </div>
        <div class="row">
          <span class="k">Williams %R [DAILY]</span>
          <span class="v orange-text">-74.86 (NEUTRAL)</span>
        </div>
        <div class="row">
          <span class="k">Momentum Tag</span>
          <span class="v orange-text">COMPRESSION</span>
        </div>
        <div class="stamp" style="margin-top:10px;">
          Daily technical state assessment for inventory timing.
        </div>
      </div>

      <div class="panel">
        <h3>STRUCTURAL LADDER (GEOMETRY)</h3>
        <div class="sub-h">Fibonacci Retracements</div>
        <div class="row"><span class="k">Weekly FIB .236</span><span class="v">$59.94</span></div>
        <div class="row"><span class="k">Weekly FIB .382</span><span class="v green-text">$49.47</span></div>
        <div class="row"><span class="k">Weekly FIB .500 (Mid)</span><span class="v blue-text">$41.00</span></div>
        <div class="row"><span class="k">Weekly FIB .618 (Floor)</span><span class="v red-text">$32.53</span></div>
        
        <div class="sub-h">FULL EMA STACK</div>
        <div class="row"><span class="k">Weekly EMA 100</span><span class="v red-text">$28.42</span></div>
        <div class="row"><span class="k">Weekly EMA 200</span><span class="v red-text">$20.15</span></div>
        <div class="row"><span class="k">Daily EMA 200</span><span class="v red-text">$36.09</span></div>
        <div class="row"><span class="k">Daily EMA 50</span><span class="v green-text">$45.18</span></div>
        <div class="row"><span class="k">Daily EMA 21</span><span class="v blue-text">$41.88</span></div>
      </div>
    </div>
  </div>

  <!-- EXECUTION -->
  <div class="exec-box">
    <h3>DEALER EXECUTION PLAN</h3>
    <table class="exec-table">
      <thead>
        <tr>
          <th>ACTION</th>
          <th>STRIKE / ZONE</th>
          <th>INTERPRETATION</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="action-cell">ACQUIRE (SHARES)</td>
          <td class="lvl-cell orange-text">Bids Only<br>≤ $36.09</td>
          <td class="interp-cell">DO NOT CHASE MARKET. Load units only at Auction Floor ($36.09).</td>
        </tr>
        <tr>
          <td class="action-cell">AUCTION BID (CSP)</td>
          <td class="lvl-cell">$36 / $35 / $34</td>
          <td class="interp-cell">Proper bid ladder staged near the AVG NMR VALUE floor.</td>
        </tr>
        <tr>
          <td class="action-cell">LEASE OR RETAIL EXIT TARGET</td>
          <td class="lvl-cell">$42.00 → $46.00</td>
          <td class="interp-cell">Initiate leasing at supply walls for distribution.</td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- IM SCORE (AT VERY BOTTOM) -->
  <div class="im-section">
    <div>
      <div class="directive-label">INVENTORY MARGIN (IM)</div>
      <div class="im-val">1.54</div>
      <div class="subtitle green-text" style="margin-top: 2px;">LEDGER: PASS</div>
    </div>
    <div class="im-math">
      <b>IM = (Supply - Spot) / (Spot - Floor)</b><br>
      ($46.36 - $40.13) / ($40.13 - $36.09) = <b>1.54</b><br>
      <span class="green-text" style="font-weight:800; font-size: 12px;">VERDICT:</span> Fundamentals allow for acquisition.
    </div>
  </div>

</div>
</body>
</html>
