// CheckAll: most profitable wallets for one token (all pools: pump.fun curve, PumpSwap, Meteora...)
const WSOL = 'So11111111111111111111111111111111111111112';
const MAX_PAGES = 10, MIN_USD = 5;

const sleep = (ms) => new Promise(z => setTimeout(z, ms));
async function rpc(method, params) {
  for (let t = 0; t < 6; t++) {
    const r = await fetch('https://mainnet.helius-rpc.com/?api-key=' + process.env.HELIUS_API_KEY, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    if (r.status === 429) { await sleep(600 * (t + 1)); continue; } // rate limited: wait and retry
    const txt = await r.text();
    let j;
    try { j = JSON.parse(txt); } catch (e) { throw new Error('Helius answered ' + r.status + ': ' + txt.slice(0, 80)); }
    if (j.error) throw new Error(j.error.message);
    return j.result;
  }
  throw new Error('Helius rate limit reached. Wait a minute and try again.');
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


async function market(ca) {
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
  return { solUsd, supply, priceSol: tp && solUsd ? Number(tp.priceUsd) / solUsd : null,
    pairs: Array.isArray(dex) ? dex.slice(0, 3).map(p => p.pairAddress).filter(Boolean) : [] };
}

async function walk(addr, t0, maxPages) { // all successful signatures of one account, newest -> oldest
  let before, out = [], done = false;
  for (let i = 0; i < maxPages; i++) {
    if (Date.now() - t0 > 50000) break; // stay inside the function time limit
    if (i) await sleep(100); // stay under the free plan request rate
    const r = await rpc('getSignaturesForAddress', [addr, Object.assign({ limit: 1000 }, before ? { before } : {})]);
    if (!r.length) { done = true; break; }
    r.forEach(x => { if (!x.err) out.push({ s: x.signature, t: x.slot }); });
    before = r[r.length - 1].signature;
    if (r.length < 1000) { done = true; break; }
  }
  return { out, done };
}

async function enhanced(key, sigs) {
  for (let t = 0; t < 3; t++) {
    const r = await fetch('https://api.helius.xyz/v0/transactions?api-key=' + key, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transactions: sigs })
    });
    if (r.status === 429) { await new Promise(z => setTimeout(z, 1200)); continue; }
    if (!r.ok) throw new Error('Helius answered ' + r.status + '. Check the API key and plan limits.');
    return r.json();
  }
  throw new Error('Helius rate limit reached. Try again in a moment.');
}

module.exports = async (req, res) => {
  const key = process.env.HELIUS_API_KEY;
  if (!key) return res.status(500).json({ error: 'HELIUS_API_KEY is not set in Vercel.' });
  try {
    if (req.method === 'POST') { // parse one batch of signatures (max 300)
      const b = req.body || {};
      const sigs = Array.isArray(b.sigs) ? b.sigs.slice(0, 300) : [];
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(b.ca || '')) || !sigs.length) return res.status(400).json({ error: 'Bad request.' });
      const W = {};
      for (let i = 0; i < sigs.length; i += 100) {
        const txs = await enhanced(key, sigs.slice(i, i + 100));
        (Array.isArray(txs) ? txs : []).forEach(tx => handle(tx, b.ca, W));
      }
      return res.status(200).json({ W });
    }
    const ca = String(req.query.ca || '').trim(); // list all signatures, oldest first
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca)) return res.status(400).json({ error: 'Invalid token address.' });
    const m = await market(ca);
    const t0 = Date.now();
    // Read the small accounts instead of the huge mint history: the pump.fun bonding curve (early phase) and the pools.
    const accts = [];
    try {
      const { PublicKey } = require('@solana/web3.js');
      accts.push(PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(ca).toBuffer()], new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'))[0].toBase58());
    } catch (e) { /* web3.js not installed: pools only */ }
    (m.pairs || []).forEach(a => { if (a && !accts.includes(a)) accts.push(a); });
    if (!accts.length) accts.push(ca);
    const seen = new Map();
    let allDone = true;
    for (let k = 0; k < accts.length; k++) {
      const w = await walk(accts[k], t0, k === 0 ? 80 : 60);
      w.out.forEach(x => seen.set(x.s, x.t));
      if (!w.done) allDone = false;
    }
    if (!seen.size && accts[0] !== ca) { // nothing on those accounts: read the mint itself
      const w = await walk(ca, t0, 120);
      w.out.forEach(x => seen.set(x.s, x.t));
      allDone = w.done;
    }
    let all = Array.from(seen.entries()).sort((a, b) => a[1] - b[1]).map(x => x[0]);
    const total = all.length;
    if (all.length > 30000) all = all.slice(0, 30000);
    res.status(200).json({ sigs: all, total, cutoff: !allDone, market: m });
  } catch (e) {
    res.status(500).json({ error: 'Something went wrong: ' + e.message });
  }
};
module.exports.handle = handle;
