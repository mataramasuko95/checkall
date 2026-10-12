// CheckAll: token data endpoint. Runs on Vercel, so the Helius key stays secret.
const SYSTEM = '11111111111111111111111111111111';
const TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

async function rpc(method, params) {
  const url = 'https://mainnet.helius-rpc.com/?api-key=' + process.env.HELIUS_API_KEY;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

module.exports = async (req, res) => {
  const ca = String(req.query.ca || '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca)) {
    return res.status(400).json({ error: 'That does not look like a Solana token address.' });
  }
  try {
    const dex = await fetch('https://api.dexscreener.com/tokens/v1/solana/' + ca).then(r => r.json());
    if (!Array.isArray(dex) || !dex.length) {
      return res.status(404).json({ error: 'No trading pair found for this token.' });
    }
    dex.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
    const p = dex[0];
    const out = {
      ca,
      name: p.baseToken.name, symbol: p.baseToken.symbol, dex: p.dexId,
      price: p.priceUsd, mcap: p.marketCap, fdv: p.fdv,
      liq: p.liquidity && p.liquidity.usd,
      vol: p.volume || {}, chg: p.priceChange || {},
      buys: p.txns && p.txns.h24 && p.txns.h24.buys,
      sells: p.txns && p.txns.h24 && p.txns.h24.sells,
      created: p.pairCreatedAt, pairs: dex.length,
      socials: (p.info && p.info.socials) || [], websites: (p.info && p.info.websites) || [],
      holders: null, mintRenounced: null, freezeRenounced: null, token2022: null, supply: null
    };

    if (process.env.HELIUS_API_KEY) {
      try {
        const [mintInfo, supply, largest] = await Promise.all([
          rpc('getAccountInfo', [ca, { encoding: 'jsonParsed' }]),
          rpc('getTokenSupply', [ca]),
          rpc('getTokenLargestAccounts', [ca])
        ]);
        const info = mintInfo.value.data.parsed.info;
        out.mintRenounced = !info.mintAuthority;
        out.freezeRenounced = !info.freezeAuthority;
        out.token2022 = mintInfo.value.owner === TOKEN22;
        out.supply = supply.value.uiAmount;

        const accts = largest.value.slice(0, 20);
        const ta = await rpc('getMultipleAccounts', [accts.map(a => a.address), { encoding: 'jsonParsed' }]);
        const owners = ta.value.map(v => v && v.data.parsed.info.owner);
        const oa = await rpc('getMultipleAccounts', [owners, { encoding: 'jsonParsed' }]);
        out.holders = accts.map((a, i) => ({
          owner: owners[i],
          amount: a.uiAmount,
          pct: out.supply ? (a.uiAmount / out.supply) * 100 : 0,
          pool: !!(oa.value[i] && oa.value[i].owner !== SYSTEM)
        }));
      } catch (e) {
        out.holdersError = e.message;
      }
    }
    res.setHeader('Cache-Control', 's-maxage=20');
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: 'Something went wrong: ' + e.message });
  }
};
