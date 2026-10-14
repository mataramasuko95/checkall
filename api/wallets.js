// CheckAll: most profitable wallets for one token (all pools: pump.fun curve, PumpSwap, Meteora...)
const WSOL = 'So11111111111111111111111111111111111111112';
const MAX_PAGES = 10, MIN_USD = 5;

async function rpc(method, params) {
  const r = await fetch('https://mainnet.helius-rpc.com/?api-key=' + process.env.HELIUS_API_KEY, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
async function getJson(url) { try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch (e) { return null; } }
const sum = (a) => a.reduce((x, t) => x + Number(t.tokenAmount), 0);

function handle(tx, mint, W) {
  if (tx.transactionError) return;
  const tt = (tx.tokenTransfers || []).filter(t => t.mint === mint && Number(t.tokenAmount) > 0);
  if (!tt.length) return;
  const get = (a) => W[a] || (W[a] = { w: a, spent: 0, recv: 0, bought: 0, sold: 0, buys: 0, sells: 0, tin: 0, tout: 0 });
  const tr = tx.feePayer;
  const tin = sum(tt.filter(t => t.toUserAccount === tr)), tout = sum(tt.filter(t => t.fromUserAccount === tr));
  let paid = 0, got = 0;
  const sw = tx.events && tx.events.swap;
  if (sw) {
    if (sw.nativeInput && sw.nativeInput.account === tr) paid += Number(sw.nativeInput.amount) / 1e9;
    if (sw.nativeOutput && sw.nativeOutput.account === tr) got += Number(sw.nativeOutput.amount) / 1e9;
    (sw.tokenInputs || []).forEach(t => { if (t.mint === WSOL && t.userAccount === tr) paid += Number(t.tokenAmount); });
    (sw.tokenOutputs || []).forEach(t => { if (t.mint === WSOL && t.userAccount === tr) got += Number(t.tokenAmount); });
  }
  if (!paid && !got) { // fallback when the swap event is missing: wSOL / SOL movements of the trader
    (tx.tokenTransfers || []).forEach(t => {
      if (t.mint !== WSOL) return;
      if (t.fromUserAccount === tr) paid += Number(t.tokenAmount);
      if (t.toUserAccount === tr) got += Number(t.tokenAmount);
    });
  }
  const dir = tin > tout ? 'buy' : tout > tin ? 'sell' : null;
  const amt = dir === 'buy' ? paid - got : dir === 'sell' ? got - paid : 0;
  if (dir && amt > 0) {
    const w = get(tr);
    if (dir === 'buy') { w.spent += amt; w.bought += tin - tout; w.buys++; }
    else { w.recv += amt; w.sold += tout - tin; w.sells++; }
    return;
  }
  tt.forEach(t => { // plain token transfer between wallets
    if (t.fromUserAccount && t.toUserAccount && t.fromUserAccount !== t.toUserAccount) {
      get(t.toUserAccount).tin += Number(t.tokenAmount);
      get(t.fromUserAccount).tout += Number(t.tokenAmount);
    }
  });
}

function summarize(W, p) { // p: {solUsd, priceSol, supply}
  const r2 = (n) => (n === null ? null : Math.round(n * 100) / 100);
  return Object.values(W).filter(w => w.spent > 0 && (p.solUsd ? w.spent * p.solUsd >= MIN_USD : w.spent >= 0.03)).map(w => {
    const remaining = Math.max(0, w.bought - w.sold + w.tin - w.tout);
    const value = p.priceSol ? remaining * p.priceSol : 0;
    const pnl = w.recv + value - w.spent;
    const mc = (sol, tok) => (tok > 0 && p.supply && p.solUsd ? (sol / tok) * p.solUsd * p.supply : null);
    return {
      wallet: w.w, roi: r2(pnl / w.spent * 100), pnl: r2(pnl), spent: r2(w.spent), received: r2(w.recv),
      entryMcap: r2(mc(w.spent, w.bought)), exitMcap: r2(mc(w.recv, w.sold)),
      holding: remaining > w.bought * 0.01, buys: w.buys, sells: w.sells,
      tin: w.tin > 0, tout: w.tout > 0
    };
  }).sort((a, b) => b.roi - a.roi).slice(0, 60);
}

module.exports = async (req, res) => {
  const ca = String(req.query.ca || '').trim();
  const key = process.env.HELIUS_API_KEY;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca)) return res.status(400).json({ error: 'Invalid token address.' });
  if (!key) return res.status(500).json({ error: 'HELIUS_API_KEY is not set in Vercel.' });
  try {
    const dex = await getJson('https://api.dexscreener.com/tokens/v1/solana/' + ca);
    const tp = Array.isArray(dex) && dex.length ? dex.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0] : null;
    let solUsd = null;
    if (tp && tp.quoteToken.address === WSOL && Number(tp.priceNative) > 0) solUsd = Number(tp.priceUsd) / Number(tp.priceNative);
    if (!solUsd) {
      const s = await getJson('https://api.dexscreener.com/tokens/v1/solana/' + WSOL);
      const sp = Array.isArray(s) ? s.filter(x => x.baseToken.address === WSOL).sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0] : null;
      if (sp) solUsd = Number(sp.priceUsd);
    }
    const sup = await rpc('getTokenSupply', [ca]).catch(() => null);
    const supply = (sup && sup.value.uiAmount) || (tp && tp.marketCap && tp.priceUsd ? tp.marketCap / Number(tp.priceUsd) : null);
    const priceSol = tp && solUsd ? Number(tp.priceUsd) / solUsd : null;

    const W = {};
    let before = '', pages = 0, txRead = 0, done = false;
    while (pages < MAX_PAGES) {
      const r = await fetch('https://api.helius.xyz/v0/addresses/' + ca + '/transactions?api-key=' + key + '&limit=100' + (before ? '&before=' + before : ''));
      if (!r.ok) {
        if (!pages) return res.status(502).json({ error: 'Helius answered ' + r.status + '. Check the API key and plan limits.' });
        break;
      }
      const txs = await r.json();
      if (!Array.isArray(txs) || !txs.length) { done = true; break; }
      pages++; txRead += txs.length;
      txs.forEach(tx => handle(tx, ca, W));
      before = txs[txs.length - 1].signature;
      if (txs.length < 100) { done = true; break; }
    }
    const rows = summarize(W, { solUsd, priceSol, supply });
    res.status(200).json({ rows, meta: { txRead, truncated: !done, wallets: Object.keys(W).length, solUsd, hasPrice: !!priceSol, minUsd: MIN_USD } });
  } catch (e) {
    res.status(500).json({ error: 'Something went wrong: ' + e.message });
  }
};
module.exports.handle = handle;
module.exports.summarize = summarize;
