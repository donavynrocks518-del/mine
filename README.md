# Paper Desk

A six-agent Solana memecoin trading bot that trades **pretend money only**, with a live dashboard you open in your browser. It reads real market data, so the results show what the strategy would actually have done. It never touches a wallet and cannot place a real trade.

## Run it

1. Install [Node.js](https://nodejs.org) (LTS version, 20 or newer).
2. Download this project to your computer.
3. Start it:
   - **Windows:** double-click `start.bat`
   - **Mac:** double-click `start.command`
   - **Any system:** run `npm install` once, then `node server.js --open` in this folder
4. Your browser opens the dashboard at <http://localhost:4280>.

Keep the bot's window open while you test: closing it stops the bot. Everything is saved in the `data` folder, so you can stop and restart without losing the account.

## The six agents

| Agent | What it does |
|---|---|
| **Scout** | Finds new and trending Solana pairs (GeckoTerminal, DexScreener). |
| **Filter** | Rejects a token if volume or liquidity is too low, the mint or freeze authority isn't revoked, the liquidity isn't locked, the top 10 holders own too much, or the creator is flagged for past rugs (RugCheck). |
| **Analyst** | Scores survivors from 0 to 1 on buy pressure, momentum, activity, pool depth and safety, with every part shown on the token's check sheet. Optionally asks Claude for the final verdict (see AI Analyst below). |
| **Executor** | Buys with at most 8% of the account, at the live price plus fee, slippage and price impact. |
| **Risk** | Reads each position's pool balances straight from the Solana chain once a second (price feed every 3 seconds as backup). Runs the exit plan below. |
| **Logger** | Records the reason for every decision. The full history is in `data/log.jsonl`. |

## The exit plan

Each open position follows these rules, all editable in Settings:

1. **Hard stop:** sell if the price falls 6% below entry.
2. **Stop to entry:** once the price is up 8%, the stop moves up to the entry price.
3. **Trailing stop:** once up 12%, sell if the price falls 8% from its peak.
4. **Take profit:** at +25%, sell half and let the rest run behind the trailing stop.
5. **Going nowhere:** close a position that hasn't reached the trailing stop after 45 minutes.
6. **Time limit:** close anything still open after 6 hours.

## Price speed

Positions tagged **on-chain** are priced from the pool's own balances, read from a Solana node every second. This works for Pump.fun AMM and Raydium standard pools. Other pool types (Meteora, Orca) are tagged **feed** and use DexScreener every 3 seconds.

The free public Solana node is fine for a paper test. For faster and steadier reads, paste a private node address (from Helius or QuickNode) into Settings → Speed.

## AI Analyst (optional)

Off by default. When on, every token that passes the filters and has a reasonable rule score is sent to Claude, which returns a buy or pass verdict, a score, a short reason and a list of green and red flags. All of it appears on the token's check sheet.

To turn it on, open Settings → AI Analyst, tick the box and paste an Anthropic API key from <https://console.anthropic.com>. The key is saved in `data/secrets.json` on your computer and is sent only to Anthropic.

- **What it sees:** price, volume and trade counts, holder spread, insider clusters, the creator's holdings, safety flags, and whether the token lists a website or socials. It does not read the posts on those socials.
- **Cost:** you pay Anthropic per call. With the default model (`claude-opus-5-5`) expect roughly 1 to 3 cents per token reviewed. Setting the model to `claude-haiku-5-5` is far cheaper and less thorough.
- **If it fails:** a bad key, a network error or an unusable answer falls back to the rule score, and the reason is written to the log.

## Using the dashboard

- **Pause / Resume** stops new scans and buys. Open positions stay protected while paused.
- **Settings** changes every rule: sizes, stops, filter limits, fee and slippage assumptions.
- **Reset** starts a fresh account at the starting balance.
- Click an **agent** or a **Why they died** row to filter the log.
- Click any **token** to see its full check sheet, score breakdown and links to its chart and RugCheck report.
- **Close** on an open position sells it at the current price.

## Kalshi weather desk

A second, completely separate desk on the **Kalshi weather** tab of the dashboard. It has its own paper account, settings, log and data folder (`data/kalshi`); pausing or resetting one desk never touches the other.

It trades Kalshi's daily high temperature contracts for ten US cities (New York, Los Angeles, Chicago, Denver, Austin, Miami, Dallas, Oklahoma City, Atlanta, Philadelphia). Each city's day is split into ranges such as "49° to 50°"; a contract pays $1 if the official high lands in its range.

| Agent | What it does |
|---|---|
| **Scout** | Pulls every open contract for those cities from Kalshi every 3 minutes. |
| **Filter** | Skips contracts with little trading, a wide bid/ask gap, a price near 0¢ or $1, or less than 30 minutes before close. |
| **Analyst** | Turns the National Weather Service forecast (and, for today, the high already recorded) into a probability for each range, blends it 50/50 with the market's price, and works out the edge on YES and NO after Kalshi's fee. |
| **Executor** | Buys only when the edge is at least 6¢ per contract, walking the real Kalshi order book so the fill price is realistic. At most 4% of the account per contract and 10% per city per day. |
| **Risk** | Marks every contract at the price it could be sold for right now, sells early if the market pays well above fair value, and pays out contracts when Kalshi settles them. |
| **Logger** | Records every decision, and scores the forecast model, the market and the blend against every settled result. |

**The number to watch is the "Forecast vs market" card.** It shows an accuracy score (lower is better) for the model, the market and the blend on every contract that has settled. If the market keeps scoring better than the blend, the desk's trades will lose money over time, however a single day goes. You need a couple of weeks of results before it means much.

Contracts settle the morning after their day, so trades only turn into wins or losses then. Until settlement the account shows what the contracts could be sold for, which starts below what was paid because of the bid/ask gap and fees.

Nothing here places a real order or needs a Kalshi account. Real trading would need a Kalshi account (18+, US resident, ID check) and its API keys.

## How honest are the numbers?

Fills are modelled, not real. Buys and sells pay a swap fee, a slippage allowance and the price impact of the trade against the pool's liquidity. A stop is a trigger, not a guaranteed price: if a token drops 30% between two price checks, the loss is 30%, not 6%.

Real trading is still harder than this. Paper fills ignore failed transactions, network congestion, priority fees and bots that front-run you, and the prices are still about a second old when the bot acts. Treat a good paper result as a reason to keep testing, not as proof.

## Data sources

Free public APIs, no keys needed: GeckoTerminal, DexScreener and RugCheck. They are rate limited, so the dots in the top bar turn red now and then; the bot retries on its own.
