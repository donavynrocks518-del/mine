# Paper Desk

A six-agent Solana memecoin trading bot that trades **pretend money only**, with a live dashboard you open in your browser. It reads real market data, so the results show what the strategy would actually have done. It never touches a wallet and cannot place a real trade.

## Run it

1. Install [Node.js](https://nodejs.org) (LTS version, 20 or newer).
2. Download this project to your computer.
3. Start it:
   - **Windows:** double-click `start.bat`
   - **Mac:** double-click `start.command`
   - **Any system:** run `node server.js --open` in this folder
4. Your browser opens the dashboard at <http://localhost:4280>.

Keep the bot's window open while you test: closing it stops the bot. Everything is saved in the `data` folder, so you can stop and restart without losing the account.

## The six agents

| Agent | What it does |
|---|---|
| **Scout** | Finds new and trending Solana pairs (GeckoTerminal, DexScreener). |
| **Filter** | Rejects a token if volume or liquidity is too low, the mint or freeze authority isn't revoked, the liquidity isn't locked, the top 10 holders own too much, or the creator is flagged for past rugs (RugCheck). |
| **Analyst** | Scores survivors from 0 to 1 on buy pressure, momentum, activity, pool depth and safety. Rule-based, with every part shown on the token's check sheet. |
| **Executor** | Buys with at most 8% of the account, at the live price plus fee, slippage and price impact. |
| **Risk** | Checks prices every 4 seconds. Sells at the hard stop, trails winners, and writes a position off if its pool disappears. |
| **Logger** | Records the reason for every decision. The full history is in `data/log.jsonl`. |

## Using the dashboard

- **Pause / Resume** stops new scans and buys. Open positions stay protected while paused.
- **Settings** changes every rule: sizes, stops, filter limits, fee and slippage assumptions.
- **Reset** starts a fresh account at the starting balance.
- Click an **agent** or a **Why they died** row to filter the log.
- Click any **token** to see its full check sheet, score breakdown and links to its chart and RugCheck report.
- **Close** on an open position sells it at the current price.

## How honest are the numbers?

Fills are modelled, not real. Buys and sells pay a swap fee, a slippage allowance and the price impact of the trade against the pool's liquidity. A stop is a trigger, not a guaranteed price: if a token drops 30% between two price checks, the loss is 30%, not 6%.

Real trading is still harder than this. Paper fills ignore failed transactions, network congestion, priority fees and bots that front-run you, and the public price feeds lag the chain by several seconds. Treat a good paper result as a reason to keep testing, not as proof.

## Data sources

Free public APIs, no keys needed: GeckoTerminal, DexScreener and RugCheck. They are rate limited, so the dots in the top bar turn red now and then; the bot retries on its own.
