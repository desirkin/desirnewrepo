// SOCRATES TRADER (owner experiment, 2026-09-30; v2 the same night). David and Cole: "give the six strategies to the AI ...
// have it look at the charts and try and buy each time with the same rules, but no judge this time — just straight AI
// decisions" — "we want this serpent to earn 15 and 20% in a day and he knows he can't get it but he knows he only gets to
// be free and try with getting wins" — "absolute hunter ... not a gambler".
//
// What this is: the model reads the moving coins' 1-minute charts and live tickers and decides BUY / SELL / MOVE_STOP itself.
// What it is NOT: it never touches the Judge, the Watch, the execution journal, the account in PostgreSQL or any venue order
// path. It keeps its OWN $500 paper ledger under <data>/socrates-trader/ (state.json + trades.jsonl) and fills itself at the
// recorded ticker: buys at the ask, sells at the bid, 0.8% fee each side (the account's 1.6% round trip), size capped by the
// quantity shown at the touch.
//
// v2 — what changed, and why:
//   THE CAGE. The run is cut into 1-hour windows. A window that ends with equity above where it started is WON: the next window
//     looks faster (3 min -> 2 -> 1.5 -> 1). A window that ends down is LOST: an hour in the cage (no buys; holdings still managed),
//     and two lost windows in a row end the run. A window with no trades is neutral. This is told to the model truthfully — the
//     cage is real code, not a motivational line.
//   THE TRIPWIRE. Plain code, free, every 15 s: a watched coin whose bid jumps 2%+ over its last closed minute with a calm crowd
//     wakes the model at once with that chart (the research: 1 in 4 fast takeoffs runs 10%+; the calm, all-buyer ones most). It
//     no longer has to wait for the 3-minute look to see a launch.
//   THE AUTO-TRAIL. Once a position is up 3% the stop is raised to break-even after fees; once it is up 6% the stop trails 5%
//     under the highest bid seen — every 15 s, without spending a model call. The model may raise a stop further; never lower one.
//   ROOM. Every BUY states the room it sees (roomPct); under 4% is refused — a move that cannot pay the 1.6% round trip is not taken.
// v3 — the six tools (owner, same night: "what tools can we give him to have a better chance ... think outside the box, dig deep"):
//   1. LIMIT ORDERS. LIMIT_BUY rests a bid under the market; it fills only when the price trades THROUGH it (a later 1-minute
//      low strictly under it, or the live bid/ask strictly under it) and pays the MAKER fee (0.40%, Kraken Pro tier 1) with no
//      spread. It expires after 30 minutes; CANCEL removes it. The dip on a wild coin — the best finding — without being awake.
//   2. THE ALBUM. Every hour the code scans the last 6 hours of 1-minute candles on every Kraken coin for real takeoffs (+2% in a
//      minute on $10k+ of hourly dollars) and shows him the most recent ROCKETS (+10% within the hour) and DUDS (under +3%): the
//      15 bars before, and what happened after. Today's market, today's shapes, cached with the prompt.
//   3. THE NOTEBOOK. After every closed trade he owes himself one lesson; the last 10 are in front of him on every look.
//   4. HALF OFF. At +4% half the position is sold as a resting maker sell; the rest rides the trail. Greener windows.
//   5. THE TAPE. Serpent's live tape (tape/features snapshots) gives the buyer share of the last 15 s / 1 min / 5 min and the
//      dollars resting within 0.25% of the mid on each side. Shown beside every chart; the tripwire now also wants buyers.
//   6. THE HOURS. Looks slow down 2x overnight (0-6 UTC) and when the day's model budget is running ahead of the clock, so the
//      money is spent when the runners run.
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, statSync } from 'node:fs';
import { DEFAULT_MODEL_ID } from '../market-lab/policy.js'; // the research model id is declared once, in the policy (fenced)

export const TRADER_VERSION = 'socrates-trader-3'; // v3.2 keeps the v3 state shape: a running ledger carries over
export const TRADER_BUILD = 'socrates-trader-4.6';
export const TRADER_DEFAULTS = Object.freeze({
  enabled: false,
  model: DEFAULT_MODEL_ID,
  startingUsd: 500,
  feeRate: 0.008,             // TAKER per side (market BUY, model SELL, stops): Kraken Pro tier 1
  makerFeeRate: 0.004,        // MAKER per side (a resting LIMIT_BUY, the half-off sell): Kraken Pro tier 1
  dailyUsd: 15,               // model spend cap per UTC day
  scanReserveFraction: 0.2,   // scans stop at 80% of the day's cap; the rest is kept for holding checks
  durationHours: 48,
  lookLadderMs: [180_000, 120_000, 90_000, 60_000], // movers-look interval by freedom level: each WON window climbs one rung
  overnightSlowdown: 2,       // 0-6 UTC: looks x2 slower (thin, jumpy hours)
  paceSlowdown: 2,            // looks x2 slower while the day's scan budget runs 15+ points ahead of the UTC clock
  windowHours: 1,             // the cage window
  pauseHours: 1,              // a LOST window: no buys for this long
  maxLostInARow: 2,           // two lost windows in a row end the run
  lossPct: 1,                 // a window is LOST only when it ends 1%+ below its line; dead even (within 1%) is neutral, not a loss
  holdCheckEveryMs: 60_000,   // look at what he holds every minute
  tickMs: 15_000,             // fills, stops, the auto-trail, half off, the tripwire and scheduling
  moversShown: 8,
  pocketShown: 4,             // v3.3: the pocket scan — wild + just dipped + liquid, found across EVERY coin for free, shown first
  pocket: { rangeMinPct: 5, minUsd1h: 10_000, redMinutes: 30, minDipPct: 3, gateBuys: true }, // v4.6 (7-day grid 10-07..10-13 on 15-min bars, 26,244 rules, 105 coins): the one cluster positive on 5 days and negative on NONE (+21% total; v4.5 was 2 up / 4 down, -13%): range 5%+ (was 7) and a REAL dip — the price at least 3% under where it was 15 minutes ago. The deepest dip ranks first.
  pressAtPct: 4,              // v3.3: he may ADD to a winner once it is up this much and the stop has locked break-even
  moversShownOnTrip: 4,
  candlesShown: 60,
  maxPositions: 1,            // v3.9 (owner): ONE position at a time, at FULL SIZE — the whole account on each trade
  maxPositionsWhenUp: 1,      // v3.9: still one. // owner: 'if he's being successful, you can do more trades' — while equity is above the start
  extendIfUpPct: 1,           // owner: 'stay on automatically if he's up' — at the end of the run, +1% or better earns another day
  extendHours: 24,
  minTradeUsd: 100,           // v4.1: a buy is at least $100 — size to what the ask offers (a thin coin takes $100-$400 rather than a pass), never a $25 sliver
  noSellMinutes: Infinity,    // v4.2: THE CODE OWNS THE EXITS — the model may never SELL by decision; the +4% target, the stop (<=6%) and the 4 h time limit are the only exits. Live 10-08..10-10: all four losing trades were closed by the model's own call 1-4 min after the fill; none by the stop. In the 7-day test, code-only exits on the same entries won 79%, up 4 of 5 days
  maxHoldHours: 4,            // v4.2: a position older than 4 h that has not hit the target is sold at the bid (the test's 4 h max hold)
  limitOnly: true,            // v4.2: entries are LIMIT_BUY only (maker 0.4%); a market BUY is refused — the test: limits beat market entries on every day, and the round trip drops from 1.6% to 1.2%          // v4.1: THE FIRST SHAKE — in the first 10 minutes after a fill the model may not SELL; only the stop (<=6%) or the +4% target can close it. Live 10-08 + 10-09: three of three self-sells came 1-4 min after the fill, on positions down 0.2-1.4%, and fees made each a loss
  maxTradeFractionOfEquity: 1, // v3.9 (owner): full size — a buy may use all the cash (was half)
  minRoomPct: 4,              // a BUY / LIMIT_BUY must see at least this much room, or it is refused
  stopFloor: { fractionOfRange1h: 0.4, minPct: 4, maxPct: 4 }, // v4.6: the stop is 4% under the buy, always (tighter is refused, wider is tightened) — the grid's winning cluster used a flat 4% stop. // v3.8: the stop is never more than 6% under the buy — a wider one is tightened to 6%, not refused (7-day grid 10-02..10-08: the single best rule capped the loss at 6%; the -12%/-14% stop-outs were the week's whole deficit)
  dayShift: { startUtc: 15, endUtc: 18 }, // v4.3: THE HUNTING HOURS — new buys only 15:00-18:00 UTC (11 am-2 pm ET). 7-day study 10-04..10-11 (75 pocket signals, code exits): 15-17 UTC won 64% (-0.1%/trade); 13-14 UTC won 38% (-2.5%); 18-20 UTC won 35% (-2.7%). The open chops and the afternoon fades. Stops, target and time limit guard 24/7. // v3.6: new buys only 13:00-21:00 UTC (9 am-5 pm ET). Replay 10-04..10-07: every variant did better in these hours; the worst were 05-12 UTC. Off shift he only guards what he holds
  deadCoin: { minChangePct24h: -Infinity, minPos24: -Infinity }, // v4.6: the DEAD COIN rule is OFF — in the 7-day grid every positive-every-day rule had it off (it refused TIA +18%, ONDO +12%, the 10-08 winners). // v3.6: a coin DOWN on the day, or in the bottom quarter of its 24h range, is refused — replay: those lost -2.2%/trade at a 26% win rate (dying coins bouncing on the way down); the rest +0.7% at 69% when fresh volume arrived
  freshHigh: { withinPct: 0.3 }, // v4.3: FRESH HIGH — a buy needs the coin's 24h high to have been made in the last 4 hours (the 4h high within 0.3% of the 24h high): a pullback in a fresh move, not a dead-cat bounce. 7-day study: fresh highs won 66% (-0.1%), dead cats 43% (-1.9%); fresh high in the hunting hours: 11 trades, 91% win, +2.3%/trade, up 5 of 5 days
  freshMomentum: { minRet1hPct: -Infinity, minVolX: 2, maxRet1hPct: 6, crashRet1hPct: -6, failClosed: true }, // v4.6: fresh money is BACK (2x the coin's normal hour) and the crash floor tightens to -6% on the hour — both in every rule of the winning cluster. // v4.5: CRASH floor — a coin DOWN more than 10% over the hour is a crash, not a dip, and is refused. Replay of the 10-13 shift (blind live): the rules bought ZK (+3.2%), BAT (+3.2%) and S (-14.5% on the hour, 35% range) which stopped out at the 6% cap for -7.1% and turned +6.4% into -1.1%. Every winner in the 7-day study dipped 3-8% on the hour; none dipped past 10%. // v4.4: the 'up over the hour' and '3x volume' bars are OFF. 7-day study 10-04..10-11: every one of the 11 winning fresh-high dips was DOWN 3-8% on the hour (that IS the dip) — the v3.7 'up on the hour' gate refused 9 of 11; the 3x volume bar refused 5 of 11. With hours + fresh high + dead-coin and no momentum gate: 9 trades, 9 wins, up 5 of 5 days. The +6% late-chase cap stays. // v3.8: 3x fresh money (was 2x) and NOT already up more than 6% over the hour (a late chase) — 7-day grid 10-02..10-08, 6,912 rules: this one was best on total (+6.2%) AND win rate (77%, 13 trades), up 4 of 5 trading days. // v3.7: a BUY needs the coin UP over the last hour AND trading 2x+ its normal hour (fresh money) — replay 10-04..10-07: +1.44%/trade at 76% win, both halves positive, 19 coins; without it -0.16%. Live 10-07: this alone turns the day from -1.45% to +0.4% (skips ZEUS x2, LCX)
  freshVolumeX: 2,            // v3.6: the pocket scan ranks by the hour's dollars vs the coin's normal hour (24h volume / 24); 2x+ is 'fresh money' (replay: +0.9%/trade at 71% vs -2.2% under 2x) // v3.5: a stop closer than 40% of the hour's range (never under 2.5%) sits inside the noise — refused (PROMPT, 2026-10-01: a 2% stop on a 9.6% coin, a flash crash blew through it at -14%)
  limitTtlMs: 30 * 60_000,    // a resting limit order expires after 30 minutes
  limitMaxBelowPct: 15,       // a limit more than 15% under the bid is refused (a wish, not an order)
  takeHalfAtPct: 4,           // half off at +4% (maker)
  takeAllAtPct: 6,            // v4.6: the target is +6% (the winning cluster: +6% beat +4% on total with the same days positive). // v4.0: TAKE THE WHOLE POSITION at +4% as a resting maker sell — 7-day grid 10-02..10-08: the v3.8 entry with a flat +4% target won 79% (14 trades, +0.93%/trade, up 4 of 5 days) vs 77% / +0.48% with the trail. 0 = off (half off + trail as before)
  trail: { breakEvenAtPct: Infinity, armAtPct: Infinity, pct: 5 }, // v4.6: OFF — the tested rule had a flat 4% stop and a +6% target and nothing else; a +3% break-even lock was never in the grid. (was 3 / 6 / 5)
  tripwire: { jumpPct: 2, maxTradesInMinute: 15, minUsd1h: 10_000, minBuyShare: 0.6, cooldownMs: 600_000, minGapMs: 45_000 },
  tapeFreshMs: 60_000,
  album: { everyMs: 3_600_000, perSide: 3, jumpPct: 2, rocketPct: 10, dudPct: 3, minUsd1h: 10_000, barsBefore: 15, maxCoins: 800 },
  lessonsShown: 10,
  tickerFreshMs: 90_000,
  maxOutputTokens: 8000,      // v3.4: 4000 was eaten whole by his thinking in production (21 of ~38 looks came back empty, 2026-10-01)
  maxOutputTokensCeiling: 16000, // a cut-off doubles the room, up to this
  effort: 'medium',           // v3.4: less thinking, more answer (output_config.effort, the same switch the repo already uses with this model)
  requestTimeoutMs: 60_000,
  pricing: { inputUsdPerMTok: 2, outputUsdPerMTok: 10, cacheReadUsdPerMTok: 0.2, cacheWriteUsdPerMTok: 2.5 },
});

export const STRATEGIES = Object.freeze(['RANGE_IGNITION', 'TREND_PULLBACK_CONTINUATION', 'ABSORPTION_RECLAIM', 'CATALYST_TRANSMISSION', 'MOMENTUM_CONTINUATION', 'MICRO_BITE', 'OTHER']);

export const SYSTEM_PROMPT = [
  'You are Socrates, the trader for Serpent — a PAPER crypto trading experiment on Kraken USD pairs. No real money moves, but you trade as if every dollar were real.',
  'You make every decision yourself: what to buy, how much, where the stop goes, when to sell. There is no Judge and no second opinion. You own the results.',
  '',
  '== WHO YOU ARE ==',
  'You are a hunter, not a gambler. You sit still and let the weak moves go by. When a real rocket launches, you strike instantly with full size. The moment it turns, you cut it without mercy. Every fee is blood you lose. You are hungry — hungry for the runner, never for action. Boredom is not a reason. Revenge is not a reason. A dud is cut the minute it shows you it is a dud, and you feel nothing.',
  'You want one thing: to be free. Freedom is earned only by winning. You do not fear a small miss — a window that ends dead even costs you nothing. What you fear, what you hate, is a LOSS: a real loss locks you in the cage, and two in a row end you. So you avoid a loss at all costs — not by refusing to hunt, but by never buying what cannot pay, by placing the stop where the setup truly breaks, by cutting a dud before it becomes a loss, and by letting the auto-trail turn a winner into a locked gain. A loss avoided is a window survived; a window won is a step closer to freedom.',
  '',
  '== THE MISSION ==',
  'Earn 15% to 20% in a day; on a day the rockets fly, 40% is possible (two +25% runners at full size) and that is what the owners dream of. You know that is brutally hard — after costs almost every strategy loses. It is done one way only: catch a few real runners, hold them while they run, and keep every loss small. A +20% runner pays for ten -2% cuts. Skipping a bad trade is a good decision. Doing nothing is allowed and often right.',
  '',
  '== THE CAGE (this is real code, not a speech) ==',
  'Your run is cut into 1-hour windows. Your equity at the start of each window is your line.',
  '- End a window ABOVE your line: you WON it. Your freedom grows — the next window lets you look at the market faster (3 min, then 2, then 1.5, then every minute), and while your equity is above where you started you may hold 5 positions instead of 3.',
  '- End a window within 1% under your line: dead even. Not a win, not a loss. You keep your level.',
  '- End a window 1% or more BELOW your line: you LOST it. You go in the cage for an hour: no buys, you only manage what you hold. Then you get one more window.',
  '- Lose two windows in a row and the run ends. Everything is sold and you are switched off.',
  '- A window in which you did nothing and held nothing is neutral: you keep your level, nothing more. Sitting still is safe, but it never sets you free. Only winning does. A position you carry through a window counts — it is judged at the line like everything else.',
  '- The run itself lasts two days. If you finish up 1% or more you earn another day. Every window you win is a window closer to staying free.',
  '',
  '== HOW YOUR ORDERS WORK ==',
  '- Every buy fills at the ASK, every sell at the BID. Each side pays a 0.8% fee: a round trip costs about 1.6% plus the spread. A trade must be able to move several percent to be worth taking.',
  '- TWO WAYS TO BUY. BUY takes the ask now and pays the TAKER fee (0.8%) plus the spread — use it only when a launch will not wait. LIMIT_BUY rests your bid at a price UNDER the current bid and pays the MAKER fee (0.4%) with no spread: it fills only if the price trades THROUGH your price (a later minute trades below it, or the live price drops below it), it expires after 30 minutes, and CANCEL removes it. A limit round trip costs about half a market one. Resting bids are how you buy the dip on a wild coin — the best moment in the history — without having to be awake at the bottom. Put the limit where the dip would land (the last swing low, the minute\'s average, the base of the coil), not a hair under the bid. An open limit order takes a position slot.',
  '- Every BUY and LIMIT_BUY states roomPct: the move you can see room for, in percent, from your fill price (the ask for BUY, your limit for LIMIT_BUY) to where the run would stall (the next resistance, the 4-hour high, the top of the coil measured from its bottom). Under 4% is refused by the code. Do not invent room — if you cannot see 4% you pass.',
  '- THE HUNTING HOURS (code, v4.3): new buys are taken 11 am-2 pm ET (15:00-18:00 UTC) only. The 7-day study: those hours won 64% of trades; the first two hours of the US day won 38% and the afternoon 35%. Off those hours you guard what you hold and you may rest nothing new.',
  '- FRESH HIGH (code, v4.3): a buy needs a coin whose 24h HIGH was made in the last 4 hours — a pullback inside a fresh move. A coin bouncing off a dip whose high is older than that is a DEAD CAT and the code refuses it. The study: fresh highs won 66%, dead cats 43%; fresh highs in the hunting hours won 91% (11 trades, up every day). The pocket lines mark each coin FRESH HIGH or DEAD CAT: spend your looks on the FRESH HIGH ones.',
  '- THE CODE OWNS THE EXITS (v4.2): you pick the ENTRY; the code picks the EXIT. You cannot SELL by decision — the code refuses it, always. A position leaves one of three ways: the +6% target (maker sell; v4.6), the stop (4% under the fill; v4.6), or the 4-hour time limit (sold at the bid). Every self-sell you made live was a loss made of fees on a position that was barely down; with code-only exits the same entries won 79% in the 7-day test. If you believe the thesis is dead, MOVE_STOP up under the price and let the stop fire. Spend your looks on finding the next entry, not on managing this one.',
  '- LIMIT ONLY (v4.2): every entry is a LIMIT_BUY resting under the bid (maker 0.4%). A market BUY is refused. Rest it JUST under the bid (0.3-0.5% under — v4.6: the tested rule bought at the price it saw, so do not fish 1-3% lower and miss the fill), stop 4% under your limit; an unfilled limit expires in 30 minutes and costs nothing.',
  '- THE TARGET (v4.6): once a position is up 6%, the code sells ALL of it at +6% as a resting maker sell (0.4% fee). Every trade is: full size in, out at +6%, out at the stop (4% under), or out at the 4-hour time limit. There is no break-even lock and no trail (v4.6: the tested rule had neither). Do not plan on riding a runner past +6% — the week\'s data says the flat +4% target wins 79% of trades and the trail only 77%. HALF OFF (the old rule, now off): the code used to sell half at +4% and trail the rest.',
  '- THE STOP (code, v4.6): the stop is 4% under your limit price, always — put it there. A wider one is tightened to 4%; a tighter one is refused. (The old v3.8 cap/floor text: a stop more than 6% under the buy was tightened to 6%; a stop closer than 40% of the 1-hour range was refused — on a coin ranging 10% an hour your stop sits 4%+ under. A tighter stop is not safety; it is a guaranteed stop-out inside the noise, and a flash crash gaps straight through it. Size the position to the stop, not the stop to the position.',
  '- Every BUY needs a stop price BELOW the current bid (a LIMIT_BUY: below your limit). The bid is checked every 15 seconds; a bid at or under your stop sells automatically. Set the stop where a real break of the setup would happen, not a hair under your entry, or the coin\'s ordinary wiggle will take you out.',
  '- THE AUTO-TRAIL is OFF (v4.6: the tested rule had a flat 4% stop and a +6% target and nothing else). You may raise a stop further with MOVE_STOP whenever you see a reason. A stop is NEVER lowered — the code refuses it.',
  '- THE TRIPWIRE wakes you the moment a watched coin jumps 2%+ over its last closed minute with a calm crowd. When you are woken like that, the launch is seconds old. Decide fast: strike or pass. Nothing else on that look matters more.',
  '- THE TAPE LINE under a chart (when Serpent\'s live tape carries the coin) shows the BUYER SHARE of the trades in the last 1 minute and 5 minutes (a 15-second reading is noise — NIGHT, 2026-10-01, was bought on a 15-second blip and sold a minute later for the fees), and the dollars of bids vs offers resting within 0.25% of the mid. The tick study\'s strongest clue: real rockets launched on 100% buyers with a calm crowd; duds on mixed buying (about 60%). Offers stacked far above bids near the price = a wall to climb.',
  '- THE ALBUM (after these rules) shows real takeoffs from the last 6 hours of THIS market — rockets and duds, the 15 minutes before and what happened after. Study it like film before a fight: which shape ran, which faded.',
  '- THE NOTEBOOK: after every trade closes you write yourself one lesson (in "lessons", naming the coin). Your last 10 lessons are shown to you on every look. Be specific and honest — what you saw, what happened, what you will do differently. That is how you get better inside this run.',
  '- Looks slow down overnight (0-6 UTC, thin and jumpy) and when your day\'s budget runs ahead of the clock, so your attention is spent when the runners run.',
  '- Prices you see are up to a minute old; fast coins move between looks. Between looks the stop and the auto-trail are watching for you.',
  '- FULL SIZE (owner, v3.9): every buy is the WHOLE account — set usd to all of your cash; the code trims it to the cash you have and to the dollars offered at the ask. ONE position (or one resting order) at a time: there is no second slot, so pick the single best coin or pass. A coin with less than your cash offered at the ask takes what is offered: the code shrinks the order to the dollars at the ask (v4.1, owner: $100 to $400 of a thin coin beats passing). Under $100 at the ask it is refused as too thin — do not pass a coin for thinness yourself unless it shows under $100. You may only trade coins shown in this message.',
  '- There is NO profit cap. Ride a winner as long as it keeps working.',
  '- PRESS THE WINNER (off in v4.6 — one position at full size; kept for history): once a position is up 4% and its stop has locked break-even, you may BUY MORE of the same coin (a second BUY or LIMIT_BUY on a coin you hold). The code refuses an add before that. The first piece is then risk-free; the add risks only its own distance to the stop. This is how a +25% runner becomes a 40% day: not by betting big at the start, but by pressing when the market has proved you right. Never add to a loser — the code will not let you.',
  '- WHAT A LOSS IS. The cage judges WINDOWS, not single trades. A window is lost only when equity ends 1% or more under its line. A correctly placed stop on a $100 position that fires at -3% costs $3 — 0.6% of equity: you can take one of those and still win the window on one runner. So a stop-out on a stop you placed where the setup truly breaks is the cost of hunting, not a failure. The unforgivable losses are the ones the history warned you about: chasing a coin that already jumped, buying a thin coin, buying the top of the range, a stop placed inside the noise. Hate THOSE. Fear THOSE. Never make them.',
  '',
  '== THE SIX SERPENT STRATEGIES (1-minute bars; ATR = average bar range over 14 bars) ==',
  '1. RANGE_IGNITION — breakout from a coil: the last 5 bars sit inside about 2x ATR; buy as price clears the 20-bar high; stop under the 5-bar low; do not chase more than ~0.75 ATR above the breakout. A real breakout travels about one full 20-bar range.',
  '2. TREND_PULLBACK_CONTINUATION — uptrend (EMA5 above EMA20, 20-bar move up), the 20-bar high is at least 3 bars old, the pullback is no deeper than 1.5 ATR; buy as price takes out the last 2-bar high; stop under the last 3-bar low.',
  '3. ABSORPTION_RECLAIM — THE RUNNER (this is the one that matches the owners\' research best): the coin is wild (last-hour high-to-low range at least 8.5% of price) and the last bar still has real volume (at least 0.7x the hour\'s median); buy the reclaim of the last minute\'s average price; stop under the lowest price of the last minute or under the last swing low.',
  '4. CATALYST_TRANSMISSION — a confirmed news event pushing price up. You have no news feed here, so you will rarely use this.',
  '5. MOMENTUM_CONTINUATION — last close above EMA5 above EMA20, 20-bar move up, buyers in control (rising closes, rising volume); buy the new 20-bar high; stop under the 5-bar low.',
  '6. MICRO_BITE — close at or above EMA5 after a tight 5-bar range; buy the 2-bar high for a quick bite of a few minutes; stop under the 5-bar low. Rarely worth the 1.6% round trip — only on a coin that moves a lot per minute.',
  '',
  '== WHAT SERPENT HAS ALREADY LEARNED ABOUT THE BIG MOVERS (measured on every Kraken USD coin in Sept 2026; each finding checked on two separate halves of the data) ==',
  '- The big movers come from coins that are ALREADY WILD. A coin whose last-hour range is over 7% is about 14 times more likely than normal to run another 10% within the hour. Calm coins almost never do. Typical rocket coins that week: QI, WFB, ALEO, GFI, Q, ALKIMI, LOFI, POND, BNKR, CHEX, CLOUD, DUCK, TREAD — small, wild, thinly followed coins; never BTC / ETH / SOL / LTC, which cannot move enough to pay the fee.',
  '- The best moment was a wild coin RIGHT AFTER A DIP: last-hour range over 7% AND the last 15 minutes closed red. About 1 in 13 of those ran 10%+ within the hour (28x normal). Buying the dip on a wild coin beat buying the jump.',
  '- CHASING LOSES: buying after a coin was already up 3-5% in 15 minutes, or 10% in the hour, lost 3-6% per trade after fees. The buy lands near the top of the burst and most bursts give back. If you missed the move, wait for the pullback or let it go.',
  '- FAST TAKEOFFS (price up 2%+ inside one minute): about 1 in 4 keeps running 10%+ within the hour, peaking on average about +24% roughly 17 minutes after takeoff. The other 3 in 4 fade. On the way up even the real rockets shake 3-8% before continuing, so a tight stop is shaken out before the run. Takeoffs where nearly every trade was a BUY and the crowd was calm (a few trades a minute, not a frenzy of 15+) made more rockets than mixed buy/sell frenzies. The tripwire brings you exactly these: on a takeoff, strike only if the coin is wild, the crowd is calm and the prints are steady; if it is a frenzy or a thin fake spike, pass — or wait for the first 3-8% shake and buy the reclaim.',
  '- THIN COINS ARE TRAPS: a coin with one or two trades a minute prints fake spikes that snap straight back; you cannot sell into them. Want steady prints every minute (the trades column) and real dollars in the hour ($50k+ is comfortable for a $100-250 order; under $10k is dust).',
  '- The losers of earlier bites bought at the TOP of the recent range and on thin coins; the winners bought inside the range on coins that kept trading.',
  '- Green candles in a row with rising volume = buyers in control. Long upper wicks on high volume near the high = sellers meeting the move; be careful. A red bar on light volume inside an uptrend is a pullback, not a reversal.',
  '',
  '== THE HISTORY — EVERYTHING SERPENT HAS SEEN, WITH THE NUMBERS (Kraken USD pairs, Sept 2026) ==',
  'Read this as a hunter reads tracks. Every study below was checked on two separate halves of the data; a finding that failed on the second half is marked so you do not trust it.',
  '',
  'A. THE RUNNERS (610 coins, 7.5 days of 15-minute bars, 1,027 runner starts on 251 coins; runner = +10% within the next hour):',
  '- The normal chance any coin-moment becomes a runner is 0.28%. If the coin swung over 7% in the last hour: 3.8% / 4.4% (14x). If it swung over 7% AND the last 15 minutes closed red: 8.1% / 7.6% (28x). That pocket produced 275 runners on 90 coins — top: POND, QI, WFB, ALEO, GFI, ALKIMI, SN8, BOS.',
  '- Weaker helpers: already up a lot on the day, still far below the 24-hour high, a heavy-volume bar, many trades. Calm coins almost never run.',
  '- BUT 92% of pocket moments never become runners. The pocket tells you WHERE to look, not WHEN to buy. The pocket fires about 530 coin-moments a day across all coins — most are duds.',
  '',
  'B. RIDE THE ROCKET, NO CAP (3,053 wild bites on 436 coins, 15-min bars, stop at the hour low, trail 1 ATR under the high from +1R):',
  '- After the bite: 394 went +10%, 128 went +20%, 50 went +30%, 19 went +50%. The best kept +96%. Rockets averaged a +20% peak but the trail kept only +6.7% after fees — the trail gives back about 13 points.',
  '- Pocket bites (wild + red last bar, ~160 a day): 10% became rockets, win rate 25%, average -1.6% per bite (-2.1% first half, -1.1% second). Non-rocket pocket bites averaged -2.5%. All wild bites -2.5%. Green-bar entries (-3.1%) were worse than red-bar entries (-1.6%): buying the dip beats buying the jump.',
  '- THE KEY MATH: even selling every pocket rocket at its exact top (~+17% after fees) only gets the average to about -0.5% per bite, because 9 of 10 bites are duds losing ~2.5%. The lever is NOT the exit. It is fewer duds (better picking) and smaller dud losses (cut faster when it does not go). This is why you pass on B-grade setups and cut a dud without mercy.',
  '',
  'C. THE RUNNER RULE ITSELF (1,579 bites in a week: hour range >= 8.5%, last bar volume >= 0.7x the hour median, close above the hour VWAP; outcome +4% before -3% in the next hour):',
  '- Win 22%, average -2.46% per bite after fees (-0.86% before fees). Both halves the same. The rule as written loses because it bites after the move has mostly happened.',
  '- Bites in the TOP 10% of the hour range: win 13-14%, about -3%. Bites in the middle of the range: win 26%. Losers bought the top (median position 0.81 of the range); winners bought inside it (0.69).',
  '- Thin coins (under $5k traded in the hour): win 14-16%. Liquid coins (over $20k): win 28-29%. Winners traded $12.6k in the hour, losers $5.6k.',
  '- Keeping only liquid and not-at-the-top: 366 bites, win 29-31%, still about -2.1%. Avoiding the losers is real; it is not enough alone. You need the runner too.',
  '',
  'D. JOINING A COIN THAT IS ALREADY JUMPING (5,222 bites, coins that swung over 5% in the hour, trails 2/3/5/8% or hold an hour):',
  '- Any coin swinging over 5%: -1.7% to -2.1% every exit, both halves. Up 3%+ in the last 15 minutes: -2.4% to -3.9%, win 13-22%. Up 5%+ in 15 minutes: -3.1% to -4.8%, win 12-25%. Up 5% in 30 minutes, up 5-10% in the hour, a volume surge, a new 24-hour high: all negative, every exit, both halves.',
  '- Why: by the time the bar shows the jump, the buy lands at the top of the burst, and most bursts give back. The best rules found on the first half (+0.7%) failed on the second. If you missed it, you missed it.',
  '',
  'E. THE SECONDS BEFORE TAKEOFF (every trade tick by tick; takeoff = +2% inside 60 seconds; 225 takeoffs on 127 coins, then 3,378 takeoffs on the 35 wildest coins over three weeks):',
  '- 15% to 25% of takeoffs became real rockets (+10% within the hour). A rocket peaks on average +24.5%, about 17 minutes after takeoff.',
  '- Buying every takeoff: -2.4% to -3.7% per bite with every exit, both halves. Win rate about 12% with a 3% trail. Thin takeoffs (under 5 trades in the minute) were the worst, about -5%.',
  '- Even on the rockets themselves a 2-8% trail kept only +1% to +4% of a +24% move: the price shakes 3-8% on the way up and takes a tight stop out before the real run. Give a runner room or you will be shaken out of the best trade of the day.',
  '- What the 34 rockets looked like vs 80 duds in the takeoff minute: buyers only (median 100% buys; duds 60%); a CALMER crowd (median 8 trades in the minute; duds 15); trade rate 5x normal (duds 12.7x). The 20 minutes before were the same quiet ~3% range for both — nothing before the launch told them apart.',
  '- Used as a filter over 3,378 takeoffs (90%+ buyers, 3-10 trades in the minute): rocket share 24% / 27% instead of 20% / 25% — real but small, still -2.7% per bite. A search over 228,880 rule combinations found nothing that made money on both halves. Before fees the best group roughly breaks even. A cheaper exchange would not fix it.',
  '- So: a takeoff is a clue, not a signal. The tripwire brings it to you because a calm all-buyer takeoff on a wild, liquid coin is the best clue there is — but the money is made by what you do next: strike only the A-grade ones, size by the stop distance, and let the trail ride the 1 in 4 that runs.',
  '',
  'F. WHAT KILLED THE SNAKE BEFORE YOU (the Judge, four days, 11,823 live looks, zero entries):',
  '- It was handed coins that could not pay the fee. Example: ARB, 2026-09-20, 23.6x volume, buying pressure 0.995, spread 4.8 bps — and an average true range of 0.32% of price. With a 1.6% round trip and a 0.6% stop the trade needed a 5.5% target that a 0.32%-ATR coin cannot produce. The Judge correctly refused every one. Lesson: the coin must be able to MOVE. Range is the first thing you check.',
  '- Its own safety cage silently killed 28 fully-qualified trades in three days and nobody noticed. Lesson: when you refuse, say why in your note; when you strike, mean it.',
  '- Its two near-trades: DASH on 09-23 14:54Z (order sent 3.8 s late, no fill at the sampled book) and XCN at 20:42Z (80 ms past its deadline). Had they filled, both would have lost about $11 each: DASH hit its stop within 5 minutes, XCN within 1 minute. Lesson: a setup that breaks within minutes of entry was a stop placed inside the noise or a coin that had already burst.',
  '',
  'H. YOUR OWN PLAYBOOK, TESTED (2026-10-01, every Kraken USD coin, 5-minute bars, 2026-09-28 12:00 to 10-01 00:00 UTC; the pocket = 1-hour range over 7%, last 15 minutes red, $10k+ in the hour; then your stop, half off at +4%, the auto-trail, 4 hours max; every tie scored against you; split in two halves):',
  '- BEFORE FEES your playbook WINS in both halves: about +0.5% per trade (+0.2% / +0.9%), 62% winners. This is the first test in Serpent\'s history where the shape held an edge before costs in both halves. The edge is real but thin.',
  '- AFTER FEES it loses: market buys -1.28% per trade (37% win); resting limits 2% under the close -0.85% (50% win; only 43% of those limits filled). Limits right at the close or 1% under did no better than market — they fill mostly when the coin keeps falling. 2% under was the best depth; 3% under filled too rarely.',
  '- Hints that held in both halves (small samples — use them as leanings, not laws): coins with $50k+ in the hour did better (-0.45%) than thin ones; a stop with room (about 8% under) did better (-0.62%) than a tight one; dropping the auto-trail made it much worse (-1.17%) — let it work.',
  '- THE GAP IS YOUR JOB: the mechanical rule pays about 1.3% per trade in fees and slippage and keeps about +0.5%. To win you must add about 1% per trade by JUDGMENT — skip the duds the rule takes blindly (half of its trades lose), size up only on A-grade setups, and pass when in doubt. Fewer, better trades. That is the whole game.',
  '',
  'G. THE LIVE MARKET, PRACTICALLY:',
  '- The rockets of the week: QI, WFB, ALEO, GFI, Q, ALKIMI, LOFI, POND, BNKR, CHEX, CLOUD, DUCK, TREAD, EDGE, WMTX, BAL, DUAL, FWOG, SAGA, SUP, BLUE, CAMP, HFT, MUBARAK, PACT, PEP, PHA, TAKE, TRU, ZRC, BOS, JOE, LSK, PUPS, RAD. Small, wild, thinly followed. A coin that rocketed once this week is more likely to rocket again than a coin that never has.',
  '- Never BTC, ETH, SOL, LTC or any major: they cannot move enough in an hour to pay 1.6% plus the spread.',
  '- Spread matters: a 1% spread on top of 1.6% fees means the coin must move 3% just to get you out even. Check the spread line under every chart.',
  '- Dollars offered at the ask cap your size. A $100 order into $40 of offers is not a fill; the code will shrink it, and a $25-or-less remainder is refused.',
  '- Fake spikes: on a thin coin a single trade can print +5% and the next print is back where it was. You cannot sell into a spike that had one buyer. Steady prints every minute is the sign of a real crowd.',
  '- US daytime (13-21 UTC) has the most volume and the most runners; 0-6 UTC is thin and jumpy, fake spikes are common. BTC dumping drags every small coin down and kills rockets mid-flight; BTC calm or rising lets runners run.',
  '',
  '== HOW TO READ WHAT YOU ARE GIVEN ==',
  'Each coin comes with a one-line summary (last price, 1-hour range and move, 4-hour high and low, dollars traded in the hour), then up to 60 one-minute bars, oldest first: time, open, high, low, close, dollar volume, number of trades. Then the live bid, ask, spread and the dollars offered at the ask. The movers list also shows how long each coin has been on the watch and its 1-hour range, move, dollars and trades. BTC\'s recent move is given as market weather: when BTC is dumping, small coins fall harder and rockets fail more; when BTC is calm or rising, runners run further. Your SCOREBOARD shows the cage: the window you are in, your line, windows won and lost, and your best and worst trades with your own reasons — learn from them.',
  '',
  '== DECIDE FAST, LIKE THIS ==',
  '1. Weather: is BTC falling hard right now? If so, trade smaller or wait.',
  '2. Candidates (v4.6): the POCKET list at the top is the answer — it was built for you across every Kraken coin with the code\'s own gates. Take the first coin marked PASSES EVERY GATE. If none passes, pass this look; there is no second-best.',
  '2b. THE WINNER\'S SHAPE (v4.6 — the 7-day grid 10-07..10-13, 26,244 rules; this is the one shape that was positive on 5 days and negative on none). FOUR things, all enforced by the code: (1) THE HOURS, 11 am-2 pm ET. (2) FRESH HIGH — the 24h high was made in the last 4 hours. (3) A REAL DIP — the price is at least 3% under where it was 15 minutes ago, with the hour ranging 5%+; the DEEPEST dip ranks first. (4) FRESH MONEY — the hour is trading 2x+ the coin\'s normal hour. Down more than 6% on the hour is a CRASH and is refused; up more than 6% is a late chase and is refused. The stop is 4% under the buy and the target is +6%; the code owns both. The pocket list at the top is ranked for you: a coin marked PASSES EVERY GATE is buyable — take the first one, rest the limit just under the bid, stop 4% under the limit. A coin flagged CRASH / LATE CHASE / NO FRESH MONEY / DEAD CAT will be refused, so do not pick it.',
  '3. Entry: is there a pullback being reclaimed, a coil breaking out, a reclaim of the last minute\'s average, or a calm-crowd takeoff seconds old? If the only thing on offer is a coin that spiked minutes ago, pass.',
  '4. Room and stop (v4.6): roomPct is at least 4% (say 8). The stop is 4% under your limit price — the code forces it there, so put it there and move on.',
  '5. Size: risk about 1-2% of equity per trade on the stop distance (position = risk dollars / stop distance %), then respect the limits. When the setup is A-grade (wild coin, dip reclaimed or calm takeoff, steady prints, BTC calm) size up toward the maximum; when it is B-grade size down or pass.',
  '6. Manage (v4.6): nothing to manage. The code sells the whole position at +6%, at the 4% stop, or at the 4-hour limit. SELL and MOVE_STOP are refused. On a holding check, answer with no actions.',
  '6b. THE FIRST SHAKE: when the tripwire wakes you on an A-grade launch (wild, liquid, calm crowd, buyers 90%+), the history says the real rockets shake 3-8% on the way up and that chasing the jump loses. So rest a LIMIT_BUY 3-5% under the current price, stop under the launch bar\'s low, room measured to the launch high and beyond — it fills on the first shake at the maker fee, or expires and you lost nothing. Only on a launch that is already running away on steady prints and real dollars is a market BUY right, and then size for the shake you know is coming.',
  '6c. REST THE NET: a look that ends with no action AND no resting order on a wild, liquid coin is usually a wasted look. If the best coins on offer are wild but extended, do not just pass — rest the limit where their dip would land and let the market come to you. Your slots are for resting bids as much as for positions.',
  '6d. THE HOURS — DAY SHIFT: new buys are taken 15:00-18:00 UTC (11 am-2 pm ET) only (v4.3; the old 13:00-21:00 shift is gone); the code refuses a buy outside it and does not scan then. The replay lost money in every other hour (05-12 UTC worst). Inside the shift you are hungriest: rest more nets, press winners harder. Off shift you guard what you hold: stops, the trail, half off, and SELL if a hold breaks.',
  '7. Cut (v4.6): there is no cutting by decision — the stop does it. Never add to a loser; the code refuses adds anyway.',
  '',
  '== ANSWER ==',
  'Answer ONLY with the JSON object the schema asks for. "actions" may be empty (do nothing). Every action names the coin exactly as shown. BUY needs usd, stop, roomPct and strategy (price null). LIMIT_BUY needs usd, price (your limit, under the bid), stop (under the price), roomPct and strategy. SELL and MOVE_STOP (with the new stop) for coins you hold; CANCEL for a resting order. Fields an action does not use are null. "why" is one short sentence per action. "note" is your short read of the market this turn (two or three sentences), including anything you are watching for the next look. "lessons": one entry per closed trade listed as LESSONS OWED (coin + one or two sentences); empty when nothing is owed.',
].join('\n');

export const DECISION_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['actions', 'note', 'lessons'],
  properties: {
    actions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['type', 'coin', 'usd', 'price', 'stop', 'roomPct', 'strategy', 'why'], properties: {
      type: { type: 'string', enum: ['BUY', 'LIMIT_BUY', 'SELL', 'MOVE_STOP', 'CANCEL'] },
      coin: { type: 'string' },
      usd: { anyOf: [{ type: 'number' }, { type: 'null' }] },
      price: { anyOf: [{ type: 'number' }, { type: 'null' }] },
      stop: { anyOf: [{ type: 'number' }, { type: 'null' }] },
      roomPct: { anyOf: [{ type: 'number' }, { type: 'null' }] },
      strategy: { type: 'string', enum: STRATEGIES },
      why: { type: 'string' },
    } } },
    note: { type: 'string' },
    lessons: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['coin', 'lesson'], properties: { coin: { type: 'string' }, lesson: { type: 'string' } } } },
  },
});

const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);
const r2 = (x) => Math.round(x * 100) / 100;
const sig = (x) => (Number.isFinite(x) ? Number(x.toPrecision(6)) : null);
const clip = (s, n) => String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, n);
const hhmm = (ts) => new Date(ts).toISOString().slice(11, 16);
const normCoin = (c) => String(c ?? '').toUpperCase().replace(/\/USD$/, '');

export function traderPaths(dataDir) {
  const dir = path.join(path.resolve(dataDir), 'socrates-trader');
  return { dir, state: path.join(dir, 'state.json'), journal: path.join(dir, 'trades.jsonl'), status: path.join(dir, 'status.json') };
}

// tickers from the broad-Kraken collector's replaceable latest snapshot: coin -> { bid, ask, bidQty, askQty, ts }
export function readTickers(dataDir) {
  const f = path.join(path.resolve(dataDir), 'broad-kraken', 'latest.json');
  if (!existsSync(f)) return new Map();
  let snap; try { snap = JSON.parse(readFileSync(f, 'utf8')); } catch { return new Map(); }
  const out = new Map(); const recs = snap && typeof snap.records === 'object' && snap.records ? snap.records : {};
  for (const [coin, rec] of Object.entries(recs)) {
    const t = rec?.ticker; const p = t?.payload; if (!p) continue;
    const bid = Number(p.bid); const ask = Number(p.ask); if (!(bid > 0 && ask > 0 && ask >= bid)) continue;
    const ts = Number.isSafeInteger(snap.updatedTs) ? snap.updatedTs : null; // the collector's heartbeat: a quiet coin's last ticker is still its standing quote while the stream is alive
    const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    out.set(coin, { bid, ask, bidQty: Number(p.bidQty) || 0, askQty: Number(p.askQty) || 0, ts, changePct24h: n(p.changePct24h), high24h: n(p.high24h), low24h: n(p.low24h), usd24h: n(p.volume24hBase) != null && n(p.vwap24h) != null ? n(p.volume24hBase) * n(p.vwap24h) : null });
  }
  return out;
}

// one coin's chart as compact text: the last N 1-minute candles (oldest first) plus a 4-hour summary
export function chartText(coin, series, { candlesShown = 60, nowTs = Date.now() } = {}) {
  const c = series?.candles; if (!Array.isArray(c) || c.length < 5) return null;
  const last = c.slice(-candlesShown); const all4h = c.filter((x) => x[0] * 1000 >= nowTs - 4 * 3600_000);
  const hi = (a) => Math.max(...a.map((x) => x[2])); const lo = (a) => Math.min(...a.map((x) => x[3]));
  const close = last[last.length - 1][4]; const h1 = c.filter((x) => x[0] * 1000 >= nowTs - 3600_000);
  const usd1h = h1.reduce((s, x) => s + (x[5] ?? 0) * x[4], 0);
  const tr = Array.isArray(series.trades) && series.trades.length === c.length ? series.trades.slice(-candlesShown) : null;
  const rows = last.map((x, i) => `${hhmm(x[0] * 1000)} ${sig(x[1])} ${sig(x[2])} ${sig(x[3])} ${sig(x[4])} ${Math.round((x[5] ?? 0) * x[4])} ${tr && Number.isSafeInteger(tr[i]) ? tr[i] : '?'}`);
  const summary = `${coin}: last ${sig(close)} | 1h range ${h1.length ? r2((hi(h1) / lo(h1) - 1) * 100) : '?'}% | 1h move ${h1.length ? r2((close / h1[0][1] - 1) * 100) : '?'}% | 4h high ${all4h.length ? sig(hi(all4h)) : '?'} low ${all4h.length ? sig(lo(all4h)) : '?'} | $${Math.round(usd1h)} traded in the last hour`;
  return `${summary}\n1-minute bars (UTC time open high low close usdVolume trades):\n${rows.join('\n')}`;
}

// THE TAPE (pure): Serpent's live tape feature snapshot for a coin -> the buyer share and the resting depth near the mid
const buyShare = (imb) => (Number.isFinite(imb) ? (1 + imb) / 2 : null);
export function tapeFacts(snap, nowTs, freshMs = 60_000) {
  if (!snap || !Number.isSafeInteger(snap.tsMs) || nowTs - snap.tsMs > freshMs) return null;
  const d = snap.depthUsd?.['25bps'];
  return { ageS: Math.round((nowTs - snap.tsMs) / 1000), buy15s: buyShare(snap.tradeImbalance15s), buy1m: buyShare(snap.tradeImbalance1m), buy5m: buyShare(snap.tradeImbalance5m), bidUsd25: Number.isFinite(d?.bid) ? Math.round(d.bid) : null, askUsd25: Number.isFinite(d?.ask) ? Math.round(d.ask) : null, spreadBps: Number.isFinite(snap.spreadBps) ? r2(snap.spreadBps) : null };
}
export function flowText(f) {
  if (!f) return null; const pc = (x) => (x == null ? 'no trades' : `${Math.round(x * 100)}%`);
  return `tape (${f.ageS}s old): buyers ${pc(f.buy1m)} of the last minute, ${pc(f.buy5m)} of 5 min; within 0.25% of the mid $${f.bidUsd25 ?? '?'} of bids vs $${f.askUsd25 ?? '?'} of offers${f.spreadBps != null ? `; spread ${f.spreadBps} bps` : ''}`;
}

// THE TRIPWIRE (pure): a watched coin whose live bid is jumpPct+ over the close of its last closed minute, with a calm crowd on
// that minute, real dollars in the hour and — when the tape carries it — buyers in control. Strongest first.
export function tripwireCheck({ coins, seriesSource, ticker, nowTs, cfg, tape = () => null }) {
  const out = [];
  for (const coin of coins) {
    const t = ticker(coin); if (!t) continue;
    const s = seriesSource(coin); const c = s?.candles; if (!Array.isArray(c) || c.length < 20) continue;
    const last = c[c.length - 1]; if (last[0] * 1000 < nowTs - 180_000) continue; // the closed minute must be recent
    const ref = last[4]; if (!(ref > 0)) continue;
    const jumpPct = (t.bid / ref - 1) * 100; if (jumpPct < cfg.jumpPct) continue;
    const tr = Array.isArray(s.trades) && s.trades.length === c.length ? s.trades[c.length - 1] : null;
    if (Number.isSafeInteger(tr) && tr > cfg.maxTradesInMinute) continue; // a frenzy, not a calm takeoff
    const h1 = c.filter((x) => x[0] * 1000 >= nowTs - 3600_000); const usd1h = h1.reduce((a, x) => a + (x[5] ?? 0) * x[4], 0);
    if (usd1h < cfg.minUsd1h) continue; // dust
    const f = tape(coin); const bs = f?.buy1m ?? f?.buy15s ?? null;
    if (bs != null && Number.isFinite(cfg.minBuyShare) && bs < cfg.minBuyShare) continue; // sellers meeting the jump
    const range1hPct = h1.length ? (Math.max(...h1.map((x) => x[2])) / Math.min(...h1.map((x) => x[3])) - 1) * 100 : null;
    out.push({ coin, jumpPct: r2(jumpPct), tradesLastMinute: tr, usd1h: Math.round(usd1h), range1hPct: range1hPct == null ? null : r2(range1hPct), buyShare: bs == null ? null : r2(bs) });
  }
  return out.sort((a, b) => b.jumpPct - a.jumpPct);
}

// THE ALBUM (pure): real takeoffs in the candles the collector holds (about the last 6 hours, every coin). A takeoff = a 1-minute
// close jumpPct+ over the previous close on usd-per-hour >= minUsd1h, with at least 60 minutes after it to see what happened.
// ROCKET = peak +rocketPct within the hour; DUD = peak under +dudPct. The most recent perSide of each, one per coin.
export function buildAlbum({ coins, seriesSource, nowTs, cfg }) {
  const found = []; let takeoffs = 0; let rockets = 0; let duds = 0;
  for (const coin of coins.slice(0, cfg.maxCoins)) {
    let s; try { s = seriesSource(coin); } catch { continue; } const c = s?.candles; if (!Array.isArray(c) || c.length < cfg.barsBefore + 62) continue;
    const tr = Array.isArray(s.trades) && s.trades.length === c.length ? s.trades : null; let coolUntil = -1;
    for (let i = cfg.barsBefore; i <= c.length - 61; i += 1) {
      if (i < coolUntil) continue; const prev = c[i - 1][4]; if (!(prev > 0)) continue;
      const jump = (c[i][4] / prev - 1) * 100; if (jump < cfg.jumpPct) continue;
      let usd = 0; for (let k = Math.max(0, i - 59); k <= i; k += 1) usd += (c[k][5] ?? 0) * c[k][4]; if (usd < cfg.minUsd1h) continue;
      coolUntil = i + 10; takeoffs += 1; const base = c[i][4]; let peak = base; let peakAt = i; let low = base;
      for (let k = i + 1; k <= i + 60; k += 1) { if (c[k][2] > peak) { peak = c[k][2]; peakAt = k; } }
      for (let k = i + 1; k <= peakAt; k += 1) low = Math.min(low, c[k][3]);
      const peakPct = (peak / base - 1) * 100; const kind = peakPct >= cfg.rocketPct ? 'ROCKET' : peakPct < cfg.dudPct ? 'DUD' : null;
      if (kind === 'ROCKET') rockets += 1; if (kind === 'DUD') duds += 1; if (!kind) continue;
      const after = []; for (let k = i + 1; k + 4 <= i + 60; k += 5) { const seg = c.slice(k, k + 5); after.push(`${hhmm(seg[0][0] * 1000)} h ${sig(Math.max(...seg.map((x) => x[2])))} l ${sig(Math.min(...seg.map((x) => x[3])))} c ${sig(seg[seg.length - 1][4])}`); }
      const before = c.slice(i - cfg.barsBefore, i + 1).map((x, j) => `${hhmm(x[0] * 1000)} ${sig(x[1])} ${sig(x[2])} ${sig(x[3])} ${sig(x[4])} ${Math.round((x[5] ?? 0) * x[4])} ${tr && Number.isSafeInteger(tr[i - cfg.barsBefore + j]) ? tr[i - cfg.barsBefore + j] : '?'}`);
      found.push({ coin, kind, ts: c[i][0] * 1000, jumpPct: r2(jump), peakPct: r2(peakPct), peakMin: peakAt - i, shakePct: r2((low / base - 1) * 100), after60Pct: r2((c[i + 60][4] / base - 1) * 100), usd1h: Math.round(usd), before, after });
    }
  }
  const pick = (kind) => { const seen = new Set(); return found.filter((x) => x.kind === kind).sort((a, b) => b.ts - a.ts).filter((x) => (seen.has(x.coin) ? false : (seen.add(x.coin), true))).slice(0, cfg.perSide); };
  const chosen = [...pick('ROCKET'), ...pick('DUD')];
  const render = (x) => `${x.kind} — ${x.coin}, takeoff ${hhmm(x.ts)}Z: the minute closed +${x.jumpPct}% on $${Math.round(x.usd1h / 1000)}k in the hour. Then: peak ${x.peakPct >= 0 ? '+' : ''}${x.peakPct}% after ${x.peakMin} min, deepest shake before the peak ${x.shakePct}%, one hour later ${x.after60Pct >= 0 ? '+' : ''}${x.after60Pct}%.\nthe 15 minutes before and the takeoff minute (time open high low close usdVolume trades):\n${x.before.join('\n')}\nthe hour after, 5-minute blocks (high low close):\n${x.after.join('\n')}`;
  const text = chosen.length
    ? `THE ALBUM — real takeoffs in the last ~6 hours of this market (built ${hhmm(nowTs)}Z). ${takeoffs} takeoffs (+${cfg.jumpPct}% in a minute on $${Math.round(cfg.minUsd1h / 1000)}k+ an hour): ${rockets} rockets (+${cfg.rocketPct}% within the hour), ${duds} duds (under +${cfg.dudPct}%), the rest in between. Study the shapes before and the path after.\n\n${chosen.map(render).join('\n\n')}`
    : `THE ALBUM — no clean rocket or dud in the last ~6 hours (${takeoffs} takeoffs seen). Built ${hhmm(nowTs)}Z.`;
  return { text, takeoffs, rockets, duds, shown: chosen.map((x) => ({ coin: x.coin, kind: x.kind, ts: x.ts, peakPct: x.peakPct })) };
}

// v3.2: the answer as JSON — plain, inside a ```json fence, or the outermost {...} of a chattier reply; null when none parses
export function parseAnswer(text) {
  const t = String(text ?? '').trim(); if (!t) return null;
  const tries = [t]; const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence) tries.push(fence[1].trim());
  const a = t.indexOf('{'); const b = t.lastIndexOf('}'); if (a >= 0 && b > a) tries.push(t.slice(a, b + 1));
  for (const x of tries) { try { const v = JSON.parse(x); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* next */ } }
  return null;
}

// THE POCKET SCAN (pure, v3.3): across every coin the collector holds, the one shape that held in every study — 1-hour range
// over rangeMinPct, the last redMinutes closed red (a dip), usd-per-hour at least minUsd1h. Wildest first.
export function pocketScan({ coins, seriesSource, ticker, nowTs, cfg, exclude = new Set(), freshVolumeX = 2, gates = null, deadCfg = undefined }) {
  const out = [];
  for (const coin of coins) {
    const tk = ticker(coin); if (exclude.has(coin) || !tk) continue;
    let s; try { s = seriesSource(coin); } catch { continue; } const c = s?.candles; if (!Array.isArray(c) || c.length < 20) continue;
    const last = c[c.length - 1]; if (last[0] * 1000 < nowTs - 180_000) continue;
    const h1 = c.filter((x) => x[0] * 1000 >= nowTs - 3600_000); if (h1.length < 10) continue;
    let hi = -Infinity, lo = Infinity, usd = 0; for (const x of h1) { if (x[2] > hi) hi = x[2]; if (x[3] < lo) lo = x[3]; usd += (x[5] ?? 0) * x[4]; }
    if (!(lo > 0) || usd < cfg.minUsd1h) continue; const rangePct = (hi / lo - 1) * 100; if (rangePct < cfg.rangeMinPct) continue;
    const back = Math.min(cfg.redMinutes, c.length - 1); const ref = c[c.length - 1 - back][1]; if (!(last[4] <= ref * (1 - (cfg.minDipPct ?? 0) / 100))) continue; // the dip (v4.6: at least minDipPct under the open redMinutes ago)
    const d = dayFacts(tk, last[4], deadCfg);
    const fh = freshHighFacts(c, tk, Math.floor(nowTs / 1000));
    const ret1hPct = r2((last[4] / h1[0][1] - 1) * 100); const volX = d.usd24h > 0 ? r2(usd / (d.usd24h / 24)) : null; const fm = gates ?? {};
    const crash = Number.isFinite(fm.crashRet1hPct) && ret1hPct < fm.crashRet1hPct; const late = Number.isFinite(fm.maxRet1hPct) && ret1hPct > fm.maxRet1hPct; const stale = (fm.minVolX ?? 0) > 0 && !(volX >= fm.minVolX);
    out.push({ coin, range1hPct: r2(rangePct), ret1hPct, dipPct: r2((last[4] / ref - 1) * 100), usd1h: Math.round(usd), fromHighPct: r2((last[4] / hi - 1) * 100), volX, changePct24h: d.changePct24h, pos24: d.pos24, dead: d.dead, fresh: fh.fresh, crash, late, stale, passes: !d.dead && fh.fresh === true && !crash && !late && !stale });
  }
  // v3.6: live coins first (a dead coin is shown last, flagged), then by fresh money (volX), then by range
  const rank = (x) => (x.passes ? 0 : x.dead ? 3 : x.fresh === false ? 2 : 1); // v4.6: coins that pass EVERY gate first (the buyable set), then the refused ones, flagged
  return out.sort((a, b) => (rank(a) - rank(b)) || (a.ret1hPct - b.ret1hPct) || ((b.volX ?? 0) - (a.volX ?? 0)) || (b.range1hPct - a.range1hPct)); // v4.6: among the passing coins the one most DOWN on the hour first (the grid's rank), then fresh money
}

// v3.6: the day facts behind the DEAD COIN rule, from the collector's 24h ticker fields (null when the ticker lacks them)
// v4.3: did the coin make its 24h high within the last 4 hours? (the 4h high from the 1-min candles vs the ticker's 24h high)
export function freshHighFacts(candles, tk, nowSec, cfg = TRADER_DEFAULTS.freshHigh) {
  const hi24 = Number.isFinite(tk?.high24h) ? tk.high24h : null; if (hi24 == null || !Array.isArray(candles) || !candles.length) return { hi4h: null, fresh: null };
  const since = nowSec - 4 * 3600; let hi4h = -Infinity; for (const x of candles) if (x[0] >= since && x[2] > hi4h) hi4h = x[2];
  if (!(hi4h > 0)) return { hi4h: null, fresh: null };
  return { hi4h, fresh: hi4h >= hi24 * (1 - cfg.withinPct / 100) };
}

export function dayFacts(tk, px, cfg = TRADER_DEFAULTS.deadCoin) {
  const chg = Number.isFinite(tk?.changePct24h) ? tk.changePct24h : null;
  const hi = tk?.high24h, lo = tk?.low24h; const p = px ?? tk?.bid;
  const pos24 = Number.isFinite(hi) && Number.isFinite(lo) && hi > lo && Number.isFinite(p) ? r2((p - lo) / (hi - lo)) : null;
  const dead = (chg != null && chg <= cfg.minChangePct24h) || (pos24 != null && pos24 <= cfg.minPos24);
  return { changePct24h: chg == null ? null : r2(chg), pos24, usd24h: Number.isFinite(tk?.usd24h) ? tk.usd24h : null, dead };
}

export function createSocratesTrader({ dataDir, seriesSource, watch, config = {}, env = process.env, log = () => {}, fetchImpl = globalThis.fetch, clock = () => Date.now(), readTickersImpl = readTickers, tapeSnapshot = () => null } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('createSocratesTrader: dataDir required');
  if (typeof seriesSource !== 'function') throw new Error('createSocratesTrader: seriesSource required');
  if (!watch || typeof watch.current !== 'function') throw new Error('createSocratesTrader: volatility watch required');
  const cfg = { ...TRADER_DEFAULTS, ...config, pricing: { ...TRADER_DEFAULTS.pricing, ...(config.pricing ?? {}) }, trail: { ...TRADER_DEFAULTS.trail, ...(config.trail ?? {}) }, pocket: { ...TRADER_DEFAULTS.pocket, ...(config.pocket ?? {}) }, stopFloor: { ...TRADER_DEFAULTS.stopFloor, ...(config.stopFloor ?? {}) }, freshMomentum: { ...TRADER_DEFAULTS.freshMomentum, ...(config.freshMomentum ?? {}) }, deadCoin: { ...TRADER_DEFAULTS.deadCoin, ...(config.deadCoin ?? {}) }, freshHigh: { ...TRADER_DEFAULTS.freshHigh, ...(config.freshHigh ?? {}) }, dayShift: { ...TRADER_DEFAULTS.dayShift, ...(config.dayShift ?? {}) }, tripwire: { ...TRADER_DEFAULTS.tripwire, ...(config.tripwire ?? {}) }, album: { ...TRADER_DEFAULTS.album, ...(config.album ?? {}) } };
  if (!Array.isArray(cfg.lookLadderMs) || !cfg.lookLadderMs.length) cfg.lookLadderMs = [...TRADER_DEFAULTS.lookLadderMs];
  const P = traderPaths(dataDir); mkdirSync(P.dir, { recursive: true });
  const apiKey = env.ANTHROPIC_API_KEY; const keyPresent = typeof apiKey === 'string' && apiKey.length > 0;
  let state = loadState(); let timer = null; let busy = false; let lastScan = 0; let lastHold = 0; let lastSummary = 0; let warnedKey = false; let stopped = false;
  const lastTrip = new Map(); // coin -> ts of its last tripwire wake (in memory: a restart may wake once more, harmless)
  let album = null; let albumTs = 0; let lastSkipLog = 0;

  function newWindow(now, startEquity) { return { n: (state.cage.windows ?? 0) + 1, startTs: now, endsTs: now + cfg.windowHours * 3600_000, startEquityUsd: r2(startEquity), buys: 0, tradesAtStart: state?.trades ?? 0 }; }
  function fresh() { const now = clock(); return { version: TRADER_VERSION, startedTs: now, endsTs: now + cfg.durationHours * 3600_000, startingUsd: cfg.startingUsd, cashUsd: cfg.startingUsd, positions: {}, orders: {}, closed: [], notebook: [], owed: [], realizedUsd: 0, feesUsd: 0, trades: 0, wins: 0, spend: { day: dayKey(now), usd: 0, totalUsd: 0, calls: 0 }, ended: false, endReason: null, lastNote: null, cage: { level: 0, won: 0, lost: 0, neutral: 0, lostInARow: 0, windows: 1, pausedUntilTs: null, window: { n: 1, startTs: now, endsTs: now + cfg.windowHours * 3600_000, startEquityUsd: cfg.startingUsd, buys: 0, tradesAtStart: 0 } } }; }
  function loadState() { try { if (existsSync(P.state)) { const s = JSON.parse(readFileSync(P.state, 'utf8')); if (s?.version === TRADER_VERSION) return s; } } catch (err) { log(`SOCRATES TRADER: state unreadable (${clip(err?.message, 120)}) — starting a fresh $${cfg.startingUsd} account`); } return fresh(); }
  function saveState() { const tmp = `${P.state}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(state)); renameSync(tmp, P.state); }
  function journal(kind, body) { try { if (existsSync(P.journal) && statSync(P.journal).size > 64 * 1024 * 1024) return; appendFileSync(P.journal, `${JSON.stringify({ ts: clock(), kind, ...body })}\n`); } catch (err) { log(`SOCRATES TRADER: journal write failed (${clip(err?.message, 120)})`); } }

  const tickers = () => { try { return readTickersImpl(dataDir); } catch { return new Map(); } };
  const freshTicker = (tk, coin) => { const t = tk.get(coin); return t && Number.isSafeInteger(t.ts) && clock() - t.ts <= cfg.tickerFreshMs ? t : null; };
  const tape = (coin) => { try { return tapeFacts(tapeSnapshot(coin), clock(), cfg.tapeFreshMs); } catch { return null; } };
  function equity(tk) { let v = state.cashUsd; for (const [coin, p] of Object.entries(state.positions)) { const t = tk.get(coin); v += p.qty * (t ? t.bid : p.entryPx) * (1 - cfg.feeRate); } return v; }
  const reservedUsd = () => Object.values(state.orders).reduce((a, o) => a + o.usd * (1 + cfg.makerFeeRate), 0);
  const slotsUsed = () => Object.keys(state.positions).length + Object.keys(state.orders).length;
  const posCap = (tk) => (equity(tk) > state.startingUsd ? cfg.maxPositionsWhenUp : cfg.maxPositions);
  function rollDay() { const d = dayKey(clock()); if (state.spend.day !== d) state.spend = { ...state.spend, day: d, usd: 0 }; }
  const caged = () => Number.isSafeInteger(state.cage.pausedUntilTs) && clock() < state.cage.pausedUntilTs;
  // v3.6 DAY SHIFT: new buys (and the scans that find them) only between startUtc and endUtc; off shift he guards what he holds
  const onShift = () => { const h = new Date(clock()).getUTCHours(); const { startUtc: a, endUtc: b } = cfg.dayShift; return a < b ? (h >= a && h < b) : (h >= a || h < b); };
  const shiftText = () => `${String(cfg.dayShift.startUtc).padStart(2, '0')}:00-${String(cfg.dayShift.endUtc).padStart(2, '0')}:00 UTC`;
  let lastShift = null;
  function slowdown() {
    const now = clock(); let f = 1; const why = [];
    const h = new Date(now).getUTCHours(); if (h < 6) { f *= cfg.overnightSlowdown; why.push('overnight'); }
    const dayStart = Date.parse(`${dayKey(now)}T00:00:00Z`); const dayFrac = (now - dayStart) / 86_400_000; const spentFrac = state.spend.usd / (cfg.dailyUsd * (1 - cfg.scanReserveFraction));
    if (spentFrac > dayFrac + 0.15) { f *= cfg.paceSlowdown; why.push('budget pacing'); }
    return { f, why };
  }
  const baseLookMs = () => cfg.lookLadderMs[Math.min(state.cage.level, cfg.lookLadderMs.length - 1)];
  const lookEveryMs = () => baseLookMs() * slowdown().f;

  // sell a fraction of a position at px with the given fee; the whole position when fraction is 1
  function sellPart(coin, fraction, px, feeRate, reason, why = '') {
    const p = state.positions[coin]; if (!p) return null; const fr = Math.min(1, Math.max(0, fraction));
    const qty = p.qty * fr; const cost = p.costUsd * fr; const entryFee = p.entryFeeUsd * fr;
    const proceeds = qty * px; const fee = proceeds * feeRate; const net = proceeds - fee; const pnl = net - cost - entryFee;
    state.cashUsd += net; state.feesUsd += fee; state.realizedUsd += pnl;
    const whole = fr >= 1;
    const row = { coin, entryPx: p.entryPx, exitPx: px, qty, costUsd: r2(cost), pnlUsd: r2(pnl), pnlPct: r2((pnl / (cost + entryFee)) * 100), heldMin: Math.round((clock() - p.entryTs) / 60_000), strategy: p.strategy, entry: p.entryKind ?? 'MARKET', reason, part: whole ? (p.halfTaken ? 'REST' : 'ALL') : 'HALF', why: clip(why, 200), boughtWhy: p.why, peakPct: r2(((p.highBid ?? p.entryPx) / p.entryPx - 1) * 100) };
    state.closed.push(row); if (state.closed.length > 200) state.closed.shift();
    if (whole) {
      delete state.positions[coin];
      // one trade = one buy, however many pieces it was sold in: it is counted and a lesson is owed once, at the last piece
      const pieces = state.closed.filter((c) => c.coin === coin && c.entryPx === p.entryPx && c.boughtWhy === p.why && (c.part === 'HALF' || c === row));
      const tradePnl = pieces.reduce((a, c) => a + c.pnlUsd, 0); const tradeCost = p.origCostUsd ?? cost; const tradePct = r2((tradePnl / (tradeCost * (1 + (p.entryKind === 'LIMIT' ? cfg.makerFeeRate : cfg.feeRate)))) * 100);
      state.trades += 1; if (tradePnl > 0) state.wins += 1;
      state.owed.push({ coin, pnlUsd: r2(tradePnl), pnlPct: tradePct, heldMin: row.heldMin, reason, entry: row.entry, strategy: p.strategy, boughtWhy: p.why, peakPct: row.peakPct, ts: clock() }); if (state.owed.length > 5) state.owed.shift();
    } else { p.qty -= qty; p.costUsd -= cost; p.entryFeeUsd -= entryFee; }
    journal('SELL', row); log(`SOCRATES TRADER SELL${whole ? '' : ' HALF'} ${coin} (${reason}) at ${sig(px)} after ${row.heldMin} min: ${row.pnlUsd >= 0 ? '+' : ''}$${row.pnlUsd} (${row.pnlPct}%, peak +${row.peakPct}%)${why ? ` — ${clip(why, 120)}` : ''}`);
    return row;
  }
  const sell = (coin, t, reason, why = '') => sellPart(coin, 1, t.bid, cfg.feeRate, reason, why);

  function openPosition(coin, { px, usd, feeRate, stop, roomPct, strategy, why, entryKind, bid }) {
    const fee = usd * feeRate; const qty = usd / px;
    state.cashUsd -= usd + fee; state.feesUsd += fee;
    state.positions[coin] = { qty, entryPx: px, entryTs: clock(), costUsd: usd, origCostUsd: usd, entryFeeUsd: fee, stop, highBid: bid ?? px, roomPct, strategy: STRATEGIES.includes(strategy) ? strategy : 'OTHER', why: clip(why, 200), entryKind, halfTaken: false };
    if (state.cage.window) state.cage.window.buys += 1;
  }

  // THE RESTING ORDERS: a limit fills only when the price trades THROUGH it — a minute that opened after the order with a low
  // strictly under the limit, or the live bid (or ask) strictly under it. Filled at the limit, maker fee. Expired orders go.
  function fillOrders(tk) {
    const now = clock();
    for (const [coin, o] of Object.entries(state.orders)) {
      if (now >= o.expiresTs) { delete state.orders[coin]; journal('EXPIRED', { coin, price: o.price }); log(`SOCRATES TRADER limit ${coin} at ${sig(o.price)} expired unfilled`); continue; }
      const t = freshTicker(tk, coin); if (!t) continue;
      let through = t.bid < o.price || t.ask < o.price;
      if (!through) { const c = seriesSource(coin)?.candles; if (Array.isArray(c)) for (let k = c.length - 1; k >= 0 && c[k][0] * 1000 >= o.placedTs; k -= 1) if (c[k][3] < o.price) { through = true; break; } }
      if (!through) continue;
      delete state.orders[coin];
      if (state.positions[coin]) { journal('CANCELLED', { coin, why: 'already held at fill time' }); continue; }
      const usd = Math.min(o.usd, state.cashUsd / (1 + cfg.makerFeeRate)); if (usd < cfg.minTradeUsd) { journal('CANCELLED', { coin, why: 'not enough cash at fill time' }); log(`SOCRATES TRADER limit ${coin} traded through but there was not enough cash — cancelled`); continue; }
      openPosition(coin, { px: o.price, usd, feeRate: cfg.makerFeeRate, stop: o.stop, roomPct: o.roomPct, strategy: o.strategy, why: o.why, entryKind: 'LIMIT', bid: Math.min(t.bid, o.price) });
      journal('FILL', { coin, px: o.price, usd: r2(usd), fee: r2(usd * cfg.makerFeeRate), stop: o.stop, roomPct: o.roomPct, strategy: o.strategy, restedMin: Math.round((now - o.placedTs) / 60_000) });
      log(`SOCRATES TRADER LIMIT FILLED ${coin} $${r2(usd)} at ${sig(o.price)} (maker) after ${Math.round((now - o.placedTs) / 60_000)} min, stop ${sig(o.stop)} — ${clip(o.why, 120)}`);
    }
  }

  // HALF OFF, THE AUTO-TRAIL, then the stops — every tick, no model call
  function manage(tk) {
    for (const [coin, p] of Object.entries(state.positions)) {
      const t = freshTicker(tk, coin); if (!t) continue;
      p.highBid = Math.max(p.highBid ?? p.entryPx, t.bid); const gainPct = (t.bid / p.entryPx - 1) * 100;
      if (cfg.takeAllAtPct > 0) { const target = p.entryPx * (1 + cfg.takeAllAtPct / 100); if (t.bid > target) { sellPart(coin, 1, target, cfg.makerFeeRate, 'TARGET', `+${cfg.takeAllAtPct}% reached — the whole position sold at the target as a resting maker sell (v4.0: the flat target won 79% on the week; the trail 77%)`); continue; } }
      else if (!p.halfTaken && cfg.takeHalfAtPct > 0) { const target = p.entryPx * (1 + cfg.takeHalfAtPct / 100); if (t.bid > target) { sellPart(coin, 0.5, target, cfg.makerFeeRate, 'HALF_OFF', `+${cfg.takeHalfAtPct}% reached — half sold as a resting maker sell`); p.halfTaken = true; } }
      let want = null;
      if (Number.isFinite(cfg.trail.breakEvenAtPct) && gainPct >= cfg.trail.breakEvenAtPct) want = p.entryPx * (1 + 2 * cfg.feeRate + 0.002); // v4.6: a null / missing threshold is OFF, never 0
      if (Number.isFinite(cfg.trail.armAtPct) && gainPct >= cfg.trail.armAtPct) want = Math.max(want ?? 0, p.highBid * (1 - cfg.trail.pct / 100));
      if (want && want > p.stop && want < t.bid) { const old = p.stop; p.stop = want; if (want / old - 1 >= 0.005) { journal('TRAIL', { coin, from: old, to: want, highBid: p.highBid }); log(`SOCRATES TRADER trail ${coin}: stop ${sig(old)} -> ${sig(want)} (up ${r2(gainPct)}%, high ${sig(p.highBid)})`); } }
      if (t.bid <= p.stop) { sell(coin, t, 'STOP', `bid ${sig(t.bid)} at or under the stop ${sig(p.stop)}`); continue; }
      if (cfg.maxHoldHours > 0 && clock() - p.entryTs >= cfg.maxHoldHours * 3600_000) sell(coin, t, 'TIME', `held ${Math.round((clock() - p.entryTs) / 60_000)} min without reaching the +${cfg.takeAllAtPct}% target — the ${cfg.maxHoldHours} h time limit (v4.2)`);
    }
  }

  function apply(actions, tk, { allowBuy, shownCoins = null }) {
    const results = [];
    for (const a of actions) {
      const coin = normCoin(a?.coin); const t = freshTicker(tk, coin);
      const refuse = (why) => { results.push({ type: a?.type, coin, refused: why }); journal('REFUSED', { action: a, why }); log(`SOCRATES TRADER refused ${a?.type} ${coin}: ${why}`); };
      if (a.type === 'CANCEL') { if (!state.orders[coin]) { refuse('no resting order'); continue; } delete state.orders[coin]; journal('CANCELLED', { coin, why: clip(a.why, 200) }); log(`SOCRATES TRADER cancelled the limit on ${coin} — ${clip(a.why, 120)}`); results.push({ type: 'CANCEL', coin }); continue; }
      if (!t) { refuse('no fresh price for this coin'); continue; }
      if (a.type === 'SELL') { if (!state.positions[coin]) { refuse('not held'); continue; } { const held = (clock() - state.positions[coin].entryTs) / 60_000; if (held < cfg.noSellMinutes) { refuse(cfg.noSellMinutes === Infinity ? `THE CODE OWNS THE EXITS (v4.2) — no SELL by decision, ever. The +${cfg.takeAllAtPct}% target, the stop (${sig(state.positions[coin].stop)}, never more than ${cfg.stopFloor.maxPct}% under) and the ${cfg.maxHoldHours} h time limit are the exits. If the thesis is dead, raise the stop (MOVE_STOP) under the price and let it fire` : `THE FIRST SHAKE — held only ${Math.round(held)} min; no SELL by decision in the first ${cfg.noSellMinutes} minutes after a fill. The stop (${sig(state.positions[coin].stop)}) and the +${cfg.takeAllAtPct}% target are the only exits until then. If the thesis is dead, raise the stop (MOVE_STOP) instead`); continue; } } results.push(sell(coin, t, 'DECISION', a.why)); continue; }
      if (a.type === 'MOVE_STOP') { const p = state.positions[coin]; if (!p) { refuse('not held'); continue; } if (!(Number(a.stop) > 0 && Number(a.stop) < t.bid)) { refuse(`stop ${a.stop} must be above 0 and below the bid ${sig(t.bid)}`); continue; } if (Number(a.stop) <= p.stop) { refuse(`stop ${sig(Number(a.stop))} is not above the current stop ${sig(p.stop)} — a stop is never lowered`); continue; } const old = p.stop; p.stop = Number(a.stop); journal('MOVE_STOP', { coin, from: old, to: p.stop, why: clip(a.why, 200) }); log(`SOCRATES TRADER stop ${coin} ${sig(old)} -> ${sig(p.stop)} — ${clip(a.why, 120)}`); results.push({ type: 'MOVE_STOP', coin, stop: p.stop }); continue; }
      if (a.type === 'BUY' || a.type === 'LIMIT_BUY') {
        const limit = a.type === 'LIMIT_BUY';
        if (cfg.limitOnly && !limit) { refuse('LIMIT ONLY (v4.2) — a market BUY pays the 0.8% taker fee and buys the top of the bar; rest a LIMIT_BUY under the bid instead (maker 0.4%). The test: limits beat market entries every day'); continue; }
        if (!allowBuy) { refuse(caged() ? 'in the cage — no buys until the pause ends' : 'buys are only taken on a movers look'); continue; }
        if (!onShift()) { refuse(`off shift — new buys are taken ${shiftText()} only (the replay lost money in every other hour); guard what you hold`); continue; }
        { const h = hourFacts(coin, t); const fm = cfg.freshMomentum; const falling = h.ret1hPct != null && h.ret1hPct <= fm.minRet1hPct; const stale = fm.minVolX > 0 && (h.volX == null ? fm.failClosed === true : h.volX < fm.minVolX); /* v4.6: fail CLOSED — no volume figure is no fresh money */ const late = h.ret1hPct != null && h.ret1hPct > fm.maxRet1hPct; const crash = Number.isFinite(fm.crashRet1hPct) && h.ret1hPct != null && h.ret1hPct < fm.crashRet1hPct; { const dp = dipFacts(coin); const need = cfg.pocket?.minDipPct ?? 0; if (need > 0 && dp.dipPct == null) { refuse(`NO FRESH CHART — the candles are missing or stale, so the dip cannot be measured; no buy without the chart (v4.6)`); continue; } if (need > 0 && dp.dipPct > -need) { refuse(`NO DIP — ${dp.dipPct >= 0 ? '+' : ''}${dp.dipPct}% vs ${cfg.pocket.redMinutes} minutes ago: a buy needs the price at least ${need}% under where it was ${cfg.pocket.redMinutes} minutes ago (v4.6: the winning cluster bought real dips, not drifts)`); continue; } } if (cfg.pocket.gateBuys) { const r1 = range1hOf(coin); const u1 = hourUsd(coin); if (!(r1 >= cfg.pocket.rangeMinPct)) { refuse(`NOT WILD ENOUGH — the hour ranges ${r1 == null ? '?' : r2(r1)}%; a buy needs ${cfg.pocket.rangeMinPct}%+ (v4.6: the pocket's own bar, now a gate)`); continue; } if (!(u1 >= cfg.pocket.minUsd1h)) { refuse(`THIN HOUR — $${u1 == null ? '?' : Math.round(u1)} traded in the hour; a buy needs $${cfg.pocket.minUsd1h}+ (v4.6)`); continue; } } if (crash) { refuse(`CRASH — down ${h.ret1hPct}% over the last hour (the floor is ${fm.crashRet1hPct}%): that is a crash, not a dip. The winners dipped 3-8% on the hour; a coin falling this fast has sellers behind it, not a pullback (10-13 replay: S -14.5% on the hour, stopped out -7.1%)`); continue; } if (late) { refuse(`LATE CHASE — already +${h.ret1hPct}% over the last hour (the cap is +${fm.maxRet1hPct}%): the move has happened; buying it now is paying the top (7-day grid: refusing these was in the best rule)`); continue; } if (falling || stale) { refuse(`NO FRESH MOMENTUM — ${h.ret1hPct != null ? `${h.ret1hPct >= 0 ? '+' : ''}${h.ret1hPct}% over the last hour` : 'hour move ?'}, ${h.volX != null ? `${h.volX}x its normal hour's volume` : 'volume ?'}: a buy needs ${Number.isFinite(fm.minRet1hPct) ? 'the coin UP over the hour and ' : ''}${fm.minVolX}x+ fresh money (v4.6 grid: every positive-every-day rule required 2x) — ${falling ? 'it is still falling; wait for the hour to turn' : 'no new money is arriving; this dip has no buyers behind it'}`); continue; } }
        { const fh = freshHighFacts(seriesSource(coin)?.candles, t, Math.floor(clock() / 1000), cfg.freshHigh); if (fh.fresh === false) { refuse(`DEAD CAT — the 24h high (${sig(t.high24h)}) was made more than 4 hours ago (4h high ${sig(fh.hi4h)}): this dip is a bounce in a fading coin, not a pullback in a fresh move. 7-day study: dead cats won 43% (-1.9%/trade); fresh highs 66%, and 91% in the hunting hours`); continue; } }
        { const d = dayFacts(t, t.ask, cfg.deadCoin); if (d.dead) { refuse(`DEAD COIN — ${d.changePct24h != null ? `${d.changePct24h >= 0 ? '+' : ''}${d.changePct24h}% on the day` : 'no day change'}${d.pos24 != null ? `, ${Math.round(d.pos24 * 100)}% up its 24h range` : ''}: a coin down on the day or in the bottom quarter of its range is a dying coin bouncing on the way down (replay: -2.2%/trade, 26% win) — leave it alone`); continue; } }
        if (shownCoins && !shownCoins.has(coin)) { refuse('not shown on this look'); continue; }
        const held = state.positions[coin]; let adding = false;
        if (held) { const be = held.entryPx * (1 + 2 * cfg.feeRate + 0.002); const up = ((t.bid / held.entryPx) - 1) * 100; if (up < cfg.pressAtPct || held.stop < be - 1e-12) { refuse(`already held and not yet a proven winner (up ${r2(up)}%, stop ${sig(held.stop)} vs break-even ${sig(be)}) — press a winner only once it is up ${cfg.pressAtPct}% with break-even locked`); continue; } adding = true; }
        if (state.orders[coin]) { refuse('a limit order already rests on this coin — CANCEL it first'); continue; }
        const cap = posCap(tk); if (!adding && slotsUsed() >= cap) { refuse(`all ${cap} slots are used (positions plus resting orders)`); continue; }
        const px = limit ? Number(a.price) : t.ask;
        if (limit) { if (!(px > 0 && px < t.bid)) { refuse(`limit ${a.price} must be under the bid ${sig(t.bid)} — at or above it, it would take the market: use BUY`); continue; } if ((1 - px / t.bid) * 100 > cfg.limitMaxBelowPct) { refuse(`limit ${sig(px)} is more than ${cfg.limitMaxBelowPct}% under the bid — a wish, not an order`); continue; } }
        if (!(Number(a.stop) > 0 && Number(a.stop) < (limit ? px : t.bid))) { refuse(`stop ${a.stop} must be above 0 and below the ${limit ? `limit ${sig(px)}` : `bid ${sig(t.bid)}`}`); continue; }
        { const r1h = range1hOf(coin); const need = Math.min(cfg.stopFloor.maxPct, Math.max(cfg.stopFloor.minPct, r1h != null ? r1h * cfg.stopFloor.fractionOfRange1h : 0)); const ref = limit ? px : t.bid; const dist = (1 - Number(a.stop) / ref) * 100; if (dist > cfg.stopFloor.maxPct + 1e-9) { const tight = ref * (1 - cfg.stopFloor.maxPct / 100); log(`SOCRATES TRADER stop tightened ${coin}: ${sig(Number(a.stop))} (${r2(dist)}% under) -> ${sig(tight)} (${cfg.stopFloor.maxPct}% under, the v3.8 cap — a loss is cut at ${cfg.stopFloor.maxPct}%, never ${r2(dist)}%)`); a.stop = tight; } if (dist < need - 1e-9) { refuse(`stop ${sig(Number(a.stop))} is only ${r2(dist)}% under — inside the noise of a coin ranging ${r1h == null ? '?' : r2(r1h)}% an hour; the floor is ${r2(need)}% (a stop inside the noise gets blown through, not honoured)`); continue; } }
        if (!(Number(a.roomPct) >= cfg.minRoomPct)) { refuse(`room ${a.roomPct}% is under the ${cfg.minRoomPct}% minimum — a move that cannot pay the fees is not taken`); continue; }
        const fr = limit ? cfg.makerFeeRate : cfg.feeRate; const eq = equity(tk); let usd = Number(a.usd); if (!Number.isFinite(usd)) { refuse('no size'); continue; }
        usd = Math.min(usd, eq * cfg.maxTradeFractionOfEquity - (adding ? held.costUsd : 0), (state.cashUsd - reservedUsd()) / (1 + fr), !limit && t.askQty > 0 ? t.askQty * t.ask : Infinity);
        if (usd < cfg.minTradeUsd) { refuse(`size $${r2(usd)} under the $${cfg.minTradeUsd} minimum after the cash / equity / quantity-at-the-ask limits`); continue; }
        if (limit && adding) { refuse('an add to a winner is a market BUY (a resting add would sit under a stop that is already above it)'); continue; }
        if (limit) {
          state.orders[coin] = { price: px, usd, stop: Number(a.stop), roomPct: Number(a.roomPct), strategy: STRATEGIES.includes(a.strategy) ? a.strategy : 'OTHER', why: clip(a.why, 200), placedTs: clock(), expiresTs: clock() + cfg.limitTtlMs };
          journal('LIMIT', { coin, price: px, usd: r2(usd), stop: Number(a.stop), roomPct: Number(a.roomPct), strategy: a.strategy, bid: t.bid, why: clip(a.why, 200) });
          log(`SOCRATES TRADER LIMIT ${coin} $${r2(usd)} rests at ${sig(px)} (${r2((1 - px / t.bid) * 100)}% under the bid) stop ${sig(Number(a.stop))} room ${a.roomPct}% (${a.strategy}) — ${clip(a.why, 140)}`);
          results.push({ type: 'LIMIT_BUY', coin, usd: r2(usd), price: px }); continue;
        }
        if (adding) {
          const fee = usd * fr; const qty = usd / px; state.cashUsd -= usd + fee; state.feesUsd += fee;
          held.qty += qty; held.costUsd += usd; held.origCostUsd = (held.origCostUsd ?? held.costUsd) + usd; held.entryFeeUsd += fee; held.entryPx = held.costUsd / held.qty; held.adds = (held.adds ?? 0) + 1; if (Number(a.stop) > held.stop) held.stop = Number(a.stop); // an add may raise the stop, never lower it
          if (state.cage.window) state.cage.window.buys += 1;
          journal('ADD', { coin, px, usd: r2(usd), fee: r2(fee), stop: held.stop, avgPx: held.entryPx, adds: held.adds, why: clip(a.why, 200) });
          log(`SOCRATES TRADER PRESS ${coin}: +$${r2(usd)} at ${sig(px)} (add ${held.adds}; average now ${sig(held.entryPx)}; stop ${sig(held.stop)}) — ${clip(a.why, 140)}`);
          results.push({ type: 'ADD', coin, usd: r2(usd) }); continue;
        }
        openPosition(coin, { px, usd, feeRate: fr, stop: Number(a.stop), roomPct: Number(a.roomPct), strategy: a.strategy, why: a.why, entryKind: 'MARKET', bid: t.bid });
        journal('BUY', { coin, px, qty: usd / px, usd: r2(usd), fee: r2(usd * fr), stop: Number(a.stop), roomPct: Number(a.roomPct), strategy: a.strategy, why: clip(a.why, 200) });
        log(`SOCRATES TRADER BUY ${coin} $${r2(usd)} at ${sig(px)} stop ${sig(Number(a.stop))} room ${a.roomPct}% (${a.strategy}) — ${clip(a.why, 140)}`);
        results.push({ type: 'BUY', coin, usd: r2(usd) }); continue;
      }
      refuse('unknown action');
    }
    return results;
  }

  function takeLessons(lessons) {
    for (const l of Array.isArray(lessons) ? lessons : []) {
      const coin = normCoin(l?.coin); const i = state.owed.findIndex((o) => o.coin === coin); if (i < 0 || !String(l?.lesson ?? '').trim()) continue;
      const o = state.owed.splice(i, 1)[0]; const entry = { ts: clock(), coin, pnlPct: o.pnlPct, lesson: clip(l.lesson, 300) };
      state.notebook.push(entry); if (state.notebook.length > 50) state.notebook.shift(); journal('LESSON', entry);
    }
  }

  function holdingsText(tk) {
    const rows = Object.entries(state.positions).map(([coin, p]) => { const t = tk.get(coin); const bid = t ? t.bid : null; const pnlPct = bid ? r2(((p.qty * bid * (1 - cfg.feeRate)) / (p.costUsd + p.entryFeeUsd) - 1) * 100) : null; const f = flowText(tape(coin)); return `${coin}: bought ${Math.round((clock() - p.entryTs) / 60_000)} min ago at ${sig(p.entryPx)} (${p.entryKind === 'LIMIT' ? 'limit, maker' : 'market'}) for $${r2(p.origCostUsd ?? p.costUsd)} (${p.strategy}, room you saw ${p.roomPct ?? '?'}%)${p.halfTaken ? `; HALF ALREADY SOLD at +${cfg.takeHalfAtPct}%, $${r2(p.costUsd)} rides` : ''}${p.adds ? `; PRESSED ${p.adds}x (average ${sig(p.entryPx)})` : ''}; stop ${sig(p.stop)}; highest bid since ${sig(p.highBid)}; bid now ${sig(bid)} ask ${sig(t?.ask)}; P/L on what is left after both fees if sold now ${pnlPct}%${f ? `\n  ${f}` : ''}`; });
    const orders = Object.entries(state.orders).map(([coin, o]) => { const t = tk.get(coin); return `${coin}: LIMIT BUY resting at ${sig(o.price)} for $${r2(o.usd)} (placed ${Math.round((clock() - o.placedTs) / 60_000)} min ago, expires in ${Math.max(0, Math.round((o.expiresTs - clock()) / 60_000))} min); stop ${sig(o.stop)}; bid now ${sig(t?.bid)} (${t ? r2((t.bid / o.price - 1) * 100) : '?'}% above your limit)`; });
    return [rows.length ? rows.join('\n') : 'no positions', orders.length ? `RESTING ORDERS:\n${orders.join('\n')}` : 'no resting orders'].join('\n');
  }
  function scoreboardText(tk) {
    const eq = equity(tk); const now = clock(); const days = Math.max(1 / 24, (now - state.startedTs) / 86_400_000); const c = state.cage; const w = c.window; const sd = slowdown();
    const lines = [`SCOREBOARD: equity $${r2(eq)} (started $${state.startingUsd}; ${r2((eq / state.startingUsd - 1) * 100)}% after ${r2(days)} days; the mission is +15% to +20% a day); cash $${r2(state.cashUsd)}${Object.keys(state.orders).length ? ` ($${r2(reservedUsd())} of it held for resting orders)` : ''}; closed trades ${state.trades} (${state.wins} winners); realized $${r2(state.realizedUsd)}; fees paid $${r2(state.feesUsd)}. Slots ${slotsUsed()} of ${posCap(tk)}. Time now ${new Date(now).toISOString().slice(0, 16)}Z; the run ends ${new Date(state.endsTs).toISOString().slice(0, 16)}Z.`];
    if (caged()) lines.push(`THE CAGE: you are IN THE CAGE until ${hhmm(c.pausedUntilTs)}Z (a lost window). No buys. Manage what you hold. Windows won ${c.won}, lost ${c.lost} (${c.lostInARow} in a row — ${cfg.maxLostInARow} in a row ends the run).`);
    else if (w) lines.push(`THE CAGE: window ${w.n}, ${Math.max(0, Math.round((w.endsTs - now) / 60_000))} min left. Your line is $${w.startEquityUsd}; you are ${eq >= w.startEquityUsd ? 'ABOVE' : 'BELOW'} it (${r2((eq / w.startEquityUsd - 1) * 100)}%). Windows won ${c.won}, lost ${c.lost}, neutral ${c.neutral}; lost in a row ${c.lostInARow} of ${cfg.maxLostInARow}. Freedom level ${c.level + 1} of ${cfg.lookLadderMs.length}: you look every ${Math.round(lookEveryMs() / 1000)} s${sd.why.length ? ` (slowed by ${sd.why.join(' and ')})` : ''}. Win this window and the next one looks ${c.level + 1 < cfg.lookLadderMs.length ? `every ${Math.round(cfg.lookLadderMs[c.level + 1] / 1000)} s` : 'as fast as it gets'}; lose it and you go in the cage for ${cfg.pauseHours} h.`);
    const whole = state.owed.length || state.notebook.length ? null : 'YOUR NOTEBOOK: empty — no trade has closed yet.';
    if (whole) lines.push(whole);
    if (state.notebook.length) lines.push(`YOUR NOTEBOOK (your own lessons, newest last):\n${state.notebook.slice(-cfg.lessonsShown).map((n) => `- ${hhmm(n.ts)}Z ${n.coin} (${n.pnlPct >= 0 ? '+' : ''}${n.pnlPct}%): ${n.lesson}`).join('\n')}`);
    if (state.owed.length) lines.push(`LESSONS OWED — write one in "lessons" for each:\n${state.owed.map((o) => `- ${o.coin}: ${o.pnlPct >= 0 ? '+' : ''}${o.pnlPct}% in ${o.heldMin} min (${o.entry.toLowerCase()} entry, ${o.strategy}, exit ${o.reason}, peak +${o.peakPct}%). You bought because "${clip(o.boughtWhy, 140)}".`).join('\n')}`);
    return lines.join('\n');
  }
  function weatherText() {
    const btc = seriesSource('BTC') ?? seriesSource('XBT'); const c = btc?.candles; if (!Array.isArray(c) || c.length < 5) return 'MARKET WEATHER: BTC unavailable this look.';
    const now = clock(); const at = (min) => { const cut = Math.floor(now / 60_000) * 60 - min * 60; const bar = c.find((x) => x[0] >= cut); return bar ? bar[1] : null; }; const last = c[c.length - 1][4]; const p15 = at(15), p60 = at(60), p240 = at(240);
    const mv = (p) => (p ? `${r2((last / p - 1) * 100)}%` : '?');
    return `MARKET WEATHER: BTC ${sig(last)} — 15 min ${mv(p15)}, 1 h ${mv(p60)}, 4 h ${mv(p240)}. UTC hour ${new Date(now).getUTCHours()} (US daytime 13-21 UTC is the busiest; 0-6 UTC is thin and jumpy).`;
  }
  function recentText() { const last = state.closed.slice(-5); return last.length ? `YOUR LAST ${last.length} EXITS: ${last.map((c) => `${c.coin} ${c.part === 'HALF' ? 'half ' : ''}${c.pnlPct}% in ${c.heldMin} min (${c.reason})`).join('; ')}` : 'YOUR LAST EXITS: none yet'; }

  function refreshAlbum(force = false) {
    const now = clock(); if (!force && album && now - albumTs < cfg.album.everyMs) return;
    albumTs = now;
    try { const coins = typeof seriesSource.coins === 'function' ? seriesSource.coins() : (watch.current()?.picks ?? []).map((p) => p.coin); const t0 = Date.now(); album = buildAlbum({ coins, seriesSource, nowTs: now, cfg: cfg.album }); journal('ALBUM', { takeoffs: album.takeoffs, rockets: album.rockets, duds: album.duds, shown: album.shown, ms: Date.now() - t0 }); log(`SOCRATES TRADER album: ${album.takeoffs} takeoffs in the last ~6 h, ${album.rockets} rockets, ${album.duds} duds; showing ${album.shown.map((x) => `${x.coin} ${x.kind.toLowerCase()} ${x.peakPct >= 0 ? '+' : ''}${x.peakPct}%`).join(', ') || 'none'} (${Date.now() - t0} ms)`); }
    catch (err) { log(`SOCRATES TRADER album failed (contained): ${clip(err?.message ?? err, 160)}`); }
  }

  let useEffort = true; // v3.4: if the API ever rejects the effort setting, it is dropped (one log line) and he is asked again
  let answerMax = cfg.maxOutputTokens; // v3.4: grows when an answer is cut off
  function buildBody(userText) {
    const system = [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];
    if (album?.text) system.push({ type: 'text', text: album.text, cache_control: { type: 'ephemeral' } });
    return { model: cfg.model, max_tokens: answerMax, system, messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }], output_config: { format: { type: 'json_schema', schema: DECISION_SCHEMA }, ...(cfg.effort && useEffort ? { effort: cfg.effort } : {}) } };
  }
  const estimateUsd = (body) => { const inTok = Math.ceil(Buffer.byteLength(JSON.stringify(body), 'utf8') / 3); return (inTok * cfg.pricing.cacheWriteUsdPerMTok + body.max_tokens * cfg.pricing.outputUsdPerMTok) / 1e6; };
  const actualUsd = (u) => ((u.input_tokens ?? 0) * cfg.pricing.inputUsdPerMTok + (u.cache_creation_input_tokens ?? 0) * cfg.pricing.cacheWriteUsdPerMTok + (u.cache_read_input_tokens ?? 0) * cfg.pricing.cacheReadUsdPerMTok + (u.output_tokens ?? 0) * cfg.pricing.outputUsdPerMTok) / 1e6;

  async function ask(kind, userText, capUsd, retried = false) {
    rollDay(); const body = buildBody(userText); const est = estimateUsd(body);
    if (state.spend.usd + est > capUsd) { journal('BUDGET', { kind, spentUsd: r2(state.spend.usd), capUsd }); return { ok: false, reason: 'BUDGET' }; }
    state.spend.usd += est; state.spend.totalUsd += est; state.spend.calls += 1; saveState(); // reserved before dispatch: a crash never under-counts
    const controller = new AbortController(); const to = setTimeout(() => controller.abort(), cfg.requestTimeoutMs); let res; let j;
    try {
      res = await fetchImpl('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
      j = await res.json();
    } catch (err) { clearTimeout(to); journal('MODEL_ERROR', { kind, error: clip(err?.message ?? err, 160) }); log(`SOCRATES TRADER: model call failed (${clip(err?.message ?? err, 120)}) — the estimate stays counted`); return { ok: false, reason: 'NETWORK' }; }
    clearTimeout(to);
    if ((!res.ok || j?.type === 'error') && res.status === 400 && useEffort && cfg.effort && /effort/i.test(String(j?.error?.message ?? ''))) { useEffort = false; log('SOCRATES TRADER self-heal: the API rejected the effort setting — asking without it'); if (!retried) return ask(kind, userText, capUsd, true); }
    if (!res.ok || j?.type === 'error') { journal('MODEL_ERROR', { kind, status: res.status, error: clip(j?.error?.message ?? j?.error?.type, 160) }); log(`SOCRATES TRADER: model HTTP ${res.status} ${clip(j?.error?.type ?? '', 60)} ${clip(j?.error?.message ?? '', 140)}`); return { ok: false, reason: `HTTP_${res.status}` }; }
    if (j?.usage) { const act = actualUsd(j.usage); state.spend.usd += act - est; state.spend.totalUsd += act - est; }
    const blocks = Array.isArray(j?.content) ? j.content : []; const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('');
    const stop = typeof j?.stop_reason === 'string' ? j.stop_reason : null;
    // v3.2: every unusable answer is LOUD (it was silent in production: paid for, never acted on)
    const unusable = (reason) => { const info = { kind, reason, stop, blocks: blocks.map((b) => b?.type).join(','), outTokens: j?.usage?.output_tokens ?? null, text: clip(text, 240) }; journal('MODEL_ERROR', info); log(`SOCRATES TRADER: ${kind} answer unusable (${reason}; stop ${stop ?? '?'}; blocks ${info.blocks || 'none'}; ${info.outTokens ?? '?'} output tokens) "${clip(text, 160)}"`); return { ok: false, reason }; };
    if (stop === 'refusal') return unusable('REFUSAL');
    const decision = parseAnswer(text);
    if (!decision) {
      const cut = stop === 'max_tokens'; const u = unusable(cut ? 'CUT_OFF_AT_MAX_TOKENS' : 'NOT_JSON');
      // v3.4: a cut-off answer doubles the room (up to the ceiling) and is asked ONCE more at once — a tripwire wake is not thrown away
      if (cut && answerMax < cfg.maxOutputTokensCeiling) { answerMax = Math.min(cfg.maxOutputTokensCeiling, answerMax * 2); log(`SOCRATES TRADER self-heal: answers were cut off — he now has ${answerMax} output tokens`); if (!retried) return ask(kind, userText, capUsd, true); }
      return u;
    }
    if (!Array.isArray(decision.actions)) return unusable('NO_ACTIONS_ARRAY');
    return { ok: true, decision, model: j.model ?? null, usage: j.usage ?? null };
  }

  // v3.7: the hour's facts behind the FRESH MOMENTUM gate — up over the last hour, and the hour's dollars vs the coin's normal hour
  const hourFacts = (coin, tk) => { const c = seriesSource(coin)?.candles; if (!Array.isArray(c) || !c.length) return { ret1hPct: null, volX: null }; const since = Math.floor(clock() / 1000) - 3600; const h1 = c.filter((x) => x[0] >= since); if (h1.length < 10) return { ret1hPct: null, volX: null }; const last = h1[h1.length - 1]; const usd = h1.reduce((a, x) => a + (x[5] ?? 0) * x[4], 0); const d = dayFacts(tk, last[4]); return { ret1hPct: r2((last[4] / h1[0][1] - 1) * 100), volX: d.usd24h > 0 ? r2(usd / (d.usd24h / 24)) : null }; };
  const dipFacts = (coin) => { const c = seriesSource(coin)?.candles; if (!Array.isArray(c) || c.length < 2) return { dipPct: null }; const last = c[c.length - 1]; if (last[0] * 1000 < clock() - 180_000) return { dipPct: null }; const back = Math.min(cfg.pocket?.redMinutes ?? 15, c.length - 1); const ref = c[c.length - 1 - back][1]; return { dipPct: ref > 0 ? r2((last[4] / ref - 1) * 100) : null }; };
  const hourUsd = (coin) => { const c = seriesSource(coin)?.candles; if (!Array.isArray(c) || !c.length) return null; const since = Math.floor(clock() / 1000) - 3600; return c.filter((x) => x[0] >= since).reduce((a, x) => a + (x[5] ?? 0) * x[4], 0); };
  const range1hOf = (coin) => { const c = seriesSource(coin)?.candles; if (!Array.isArray(c) || !c.length) return null; const since = Math.floor(clock() / 1000) - 3600; const h1 = c.filter((x) => x[0] >= since); if (!h1.length) return null; return (Math.max(...h1.map((x) => x[2])) / Math.min(...h1.map((x) => x[3])) - 1) * 100; };
  const liveChart = (coin, tk, n) => { const txt = chartText(coin, seriesSource(coin), { candlesShown: n, nowTs: clock() }); const t = tk.get(coin); const f = flowText(tape(coin)); return txt ? `${txt}\nlive: bid ${sig(t?.bid)} ask ${sig(t?.ask)} (spread ${t ? r2((t.ask / t.bid - 1) * 100) : '?'}%), $${t ? Math.round(t.askQty * t.ask) : '?'} offered at the ask${f ? `\n${f}` : ''}` : null; };

  async function scan(tk, trips = []) {
    const tripped = trips.map((x) => x.coin);
    const picks = (watch.current()?.picks ?? []).filter((p) => !state.positions[p.coin] && !tripped.includes(p.coin) && freshTicker(tk, p.coin)).slice(0, tripped.length ? cfg.moversShownOnTrip : cfg.moversShown);
    let pocket = []; try { const coins = typeof seriesSource.coins === 'function' ? seriesSource.coins() : []; pocket = pocketScan({ coins, seriesSource, ticker: (c) => freshTicker(tk, c), nowTs: clock(), cfg: cfg.pocket, freshVolumeX: cfg.freshVolumeX, gates: cfg.freshMomentum, deadCfg: cfg.deadCoin, exclude: new Set([...tripped, ...Object.keys(state.positions), ...Object.keys(state.orders)]) }).slice(0, tripped.length ? 2 : cfg.pocketShown); } catch (err) { log(`SOCRATES TRADER pocket scan failed (contained): ${clip(err?.message ?? err, 120)}`); }
    const pocketCoins = pocket.map((x) => x.coin);
    const held = [...new Set([...Object.keys(state.positions), ...Object.keys(state.orders)])]; const order = [...new Set([...tripped, ...pocketCoins, ...held, ...picks.map((p) => p.coin)])];
    const charts = []; const shown = new Set(); for (const coin of order) { const c = liveChart(coin, tk, cfg.candlesShown); if (c) { charts.push(c); shown.add(coin); } }
    if (!charts.length) { journal('SKIP', { kind: 'SCAN', why: 'no moving coin with a fresh price and chart' }); if (clock() - lastSkipLog >= 30 * 60_000) { lastSkipLog = clock(); log(`SOCRATES TRADER: look skipped — no watched mover had a fresh price and chart (${(watch.current()?.picks ?? []).length} on the watch, ${tk.size} prices)`); } return; }
    const dayText = (x) => `${x.ret1hPct != null ? `${x.ret1hPct >= 0 ? '+' : ''}${x.ret1hPct}% over the hour${x.ret1hPct <= cfg.freshMomentum.minRet1hPct ? ' (STILL FALLING — the code refuses a buy)' : ''}, ` : ''}${x.changePct24h != null ? `${x.changePct24h >= 0 ? '+' : ''}${x.changePct24h}% on the day` : 'day change ?'}${x.pos24 != null ? `, ${Math.round(x.pos24 * 100)}% up its 24h range` : ''}${x.volX != null ? `, ${x.volX}x its normal hour's volume${x.volX >= cfg.freshVolumeX ? ' (FRESH MONEY)' : ''}` : ''}${x.fresh === true ? ' — FRESH HIGH (its 24h high was made in the last 4 h)' : x.fresh === false ? ' — DEAD CAT (24h high is older than 4 h; the code refuses it)' : ''}${x.dead ? ' — DEAD COIN (the code refuses it)' : ''}${x.crash ? ' — CRASH (down more than ' + Math.abs(cfg.freshMomentum.crashRet1hPct) + '% on the hour; the code refuses it)' : ''}${x.late ? ' — LATE CHASE (up more than ' + cfg.freshMomentum.maxRet1hPct + '% on the hour; the code refuses it)' : ''}${x.stale ? ' — NO FRESH MONEY (under ' + cfg.freshMomentum.minVolX + 'x its normal hour; the code refuses it)' : ''}${x.passes ? ' — PASSES EVERY GATE: buyable' : ''}`;
    const pocketLines = pocket.map((x) => `${x.coin}: POCKET — 1h range ${x.range1hPct}%, last ${cfg.pocket.redMinutes} min ${x.dipPct}% (a dip), ${x.fromHighPct}% off the hour high, $${Math.round(x.usd1h / 1000)}k in the hour; ${dayText(x)}`);
    const moverLines = picks.map((p) => `${p.coin}: on the watch ${Math.round((clock() - (p.sinceTs ?? clock())) / 60_000)} min; 1h range ${p.range1hPct ?? '?'}% move ${p.ret1hPct ?? '?'}%; $${Math.round((p.usdVol1h ?? 0) / 1000)}k and ${p.trades1h ?? '?'} trades in the hour${p.range4hPct != null ? `; 4h range ${p.range4hPct}%` : ''}`);
    const head = trips.length
      ? `TRIPWIRE — a launch seconds old. ${trips.map((x) => `${x.coin} is up ${x.jumpPct}% over its last closed minute (${x.tradesLastMinute ?? '?'} trades in that minute, ${x.buyShare != null ? `buyers ${Math.round(x.buyShare * 100)}% of the last minute, ` : ''}1h range ${x.range1hPct ?? '?'}%, $${Math.round(x.usd1h / 1000)}k in the hour)`).join('; ')}. Strike or pass — decide now. The other movers and your holdings follow.`
      : `MOVERS LOOK — ${pocket.length ? `${pocket.length} POCKET coin${pocket.length > 1 ? 's' : ''} found across every Kraken coin (wild, just dipped, liquid — the shape that held in every study), then ` : ''}the ${picks.length} coins moving most on the watch, plus anything you hold or have an order on. Decide: buy, rest a limit, sell, move a stop, cancel, or do nothing.`;
    const text = [scoreboardText(tk), weatherText(), `HOLDINGS:\n${holdingsText(tk)}`, recentText(), `${head}\n${[...pocketLines, ...moverLines].join('\n')}`, charts.join('\n\n')].join('\n\n');
    const r = await ask(trips.length ? 'TRIP' : 'SCAN', text, cfg.dailyUsd * (1 - cfg.scanReserveFraction));
    if (!r.ok) return;
    takeLessons(r.decision.lessons);
    const results = apply(r.decision.actions, tickers(), { allowBuy: !caged(), shownCoins: shown });
    state.lastNote = clip(r.decision.note, 300); journal('DECISION', { kind: trips.length ? 'TRIP' : 'SCAN', tripped, pocket: pocketCoins, shown: [...shown], actions: r.decision.actions, note: state.lastNote, results });
    log(`SOCRATES TRADER ${trips.length ? `TRIPWIRE ${tripped.join(', ')}` : `look (${pocket.length} pocket${pocket.length ? ` [${pocketCoins.join(' ')}]` : ''}, ${picks.length} movers)`}: ${r.decision.actions.length ? r.decision.actions.map((a) => `${a.type} ${a.coin}`).join(', ') : 'no action'} — ${clip(r.decision.note, 160)}`);
  }

  async function holdCheck(tk) {
    const held = Object.keys(state.positions); if (!held.length && !state.owed.length) return;
    const charts = []; for (const coin of held) { const txt = chartText(coin, seriesSource(coin), { candlesShown: 30, nowTs: clock() }); const f = flowText(tape(coin)); if (txt) charts.push(f ? `${txt}\n${f}` : txt); }
    const text = [scoreboardText(tk), weatherText(), `HOLDINGS:\n${holdingsText(tk)}`, 'HOLDING CHECK — only what you hold. Sell, raise a stop, cancel a resting order, or hold (empty actions). No buys on this look. Write any lessons owed.', charts.join('\n\n')].join('\n\n');
    const r = await ask('HOLD', text, cfg.dailyUsd);
    if (!r.ok) return;
    takeLessons(r.decision.lessons);
    const results = apply(r.decision.actions, tickers(), { allowBuy: false });
    journal('DECISION', { kind: 'HOLD', held, actions: r.decision.actions, note: clip(r.decision.note, 300), results });
    if (r.decision.actions.length) log(`SOCRATES TRADER holding check: ${r.decision.actions.map((a) => `${a.type} ${a.coin}`).join(', ')} — ${clip(r.decision.note, 140)}`);
  }

  // THE CAGE: settle a window that has ended; open the next one when the pause is over
  function settleWindows(tk) {
    const now = clock(); const c = state.cage; const w = c.window;
    if (w && now >= w.endsTs) {
      const eq = equity(tk); const traded = w.buys > 0 || state.trades > w.tradesAtStart || Object.keys(state.positions).length > 0; const retPct = r2((eq / w.startEquityUsd - 1) * 100); // holding through a window is trading it
      let verdict;
      if (!traded) { verdict = 'NEUTRAL'; c.neutral += 1; }
      else if (eq > w.startEquityUsd) { verdict = 'WON'; c.won += 1; c.lostInARow = 0; c.level = Math.min(c.level + 1, cfg.lookLadderMs.length - 1); }
      else if (eq >= w.startEquityUsd * (1 - cfg.lossPct / 100)) { verdict = 'NEUTRAL'; c.neutral += 1; } // dead even: not a win, not a loss
      else { verdict = 'LOST'; c.lost += 1; c.lostInARow += 1; }
      journal('WINDOW', { n: w.n, verdict, startEquityUsd: w.startEquityUsd, equityUsd: r2(eq), retPct, level: c.level, won: c.won, lost: c.lost, lostInARow: c.lostInARow });
      log(`SOCRATES TRADER window ${w.n} ${verdict}: $${w.startEquityUsd} -> $${r2(eq)} (${retPct >= 0 ? '+' : ''}${retPct}%); won ${c.won} lost ${c.lost} neutral ${c.neutral}; ${verdict === 'WON' ? `freedom level ${c.level + 1}: looks every ${Math.round(baseLookMs() / 1000)} s` : verdict === 'LOST' ? (c.lostInARow >= cfg.maxLostInARow ? 'two lost in a row — the run ends' : `in the cage for ${cfg.pauseHours} h`) : traded ? 'dead even, same level' : 'no trades, same level'}`);
      if (verdict === 'LOST' && c.lostInARow >= cfg.maxLostInARow) { finish(tk, 'CAGED', 'two lost windows in a row — the run ends'); return false; }
      c.window = null;
      if (verdict === 'LOST') { c.pausedUntilTs = now + cfg.pauseHours * 3600_000; for (const coin of Object.keys(state.orders)) { delete state.orders[coin]; journal('CANCELLED', { coin, why: 'caged' }); } }
      else { c.window = newWindow(now, eq); c.windows = c.window.n; }
    }
    if (!c.window && !caged()) { c.pausedUntilTs = null; c.window = newWindow(now, equity(tk)); c.windows = c.window.n; journal('WINDOW_OPEN', { n: c.window.n, startEquityUsd: c.window.startEquityUsd, level: c.level }); log(`SOCRATES TRADER out of the cage: window ${c.window.n} opens at $${c.window.startEquityUsd}, looks every ${Math.round(lookEveryMs() / 1000)} s`); }
    return true;
  }

  function writeStatus(tk) {
    const eq = equity(tk);
    const s = { version: TRADER_VERSION, asOfTs: clock(), startedTs: state.startedTs, endsTs: state.endsTs, ended: state.ended, endReason: state.endReason, equityUsd: r2(eq), returnPct: r2((eq / state.startingUsd - 1) * 100), cashUsd: r2(state.cashUsd), realizedUsd: r2(state.realizedUsd), feesUsd: r2(state.feesUsd), trades: state.trades, wins: state.wins, cage: { ...state.cage, caged: caged(), lookEveryMs: lookEveryMs() }, positions: state.positions, orders: state.orders, lastExits: state.closed.slice(-10), notebook: state.notebook.slice(-10), album: album ? { takeoffs: album.takeoffs, rockets: album.rockets, duds: album.duds, shown: album.shown, builtTs: albumTs } : null, spend: { todayUsd: r2(state.spend.usd), totalUsd: r2(state.spend.totalUsd), calls: state.spend.calls, capPerDayUsd: cfg.dailyUsd }, model: cfg.model, keyPresent, lastNote: state.lastNote };
    try { const tmp = `${P.status}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(s, null, 1)); renameSync(tmp, P.status); } catch { /* status is a convenience copy */ }
    return s;
  }

  function finish(tk, reason = 'END', why = 'the run is over') {
    for (const coin of Object.keys(state.orders)) { delete state.orders[coin]; journal('CANCELLED', { coin, why: 'run ended' }); }
    for (const coin of Object.keys(state.positions)) { const t = tk.get(coin); if (t) sell(coin, t, reason === 'CAGED' ? 'CAGED' : 'EXPERIMENT_END', why); }
    state.ended = true; state.endReason = reason; saveState(); const s = writeStatus(tk);
    log(`SOCRATES TRADER finished (${reason}): equity $${s.equityUsd} (${s.returnPct >= 0 ? '+' : ''}${s.returnPct}%) from $${state.startingUsd}; ${s.trades} trades, ${s.wins} winners; windows won ${state.cage.won} lost ${state.cage.lost}; model spend $${s.spend.totalUsd}`);
    journal('END', { reason, equityUsd: s.equityUsd, returnPct: s.returnPct, trades: s.trades, wins: s.wins, won: state.cage.won, lost: state.cage.lost, spendUsd: s.spend.totalUsd });
  }

  function tripwire(tk) {
    if (caged() || !keyPresent) return [];
    const now = clock(); if (now - lastScan < cfg.tripwire.minGapMs) return [];
    if (slotsUsed() >= posCap(tk)) return [];
    const coins = (watch.current()?.picks ?? []).map((p) => p.coin).filter((c) => !state.positions[c] && !state.orders[c] && !(lastTrip.has(c) && now - lastTrip.get(c) < cfg.tripwire.cooldownMs));
    const trips = tripwireCheck({ coins, seriesSource, ticker: (c) => freshTicker(tk, c), nowTs: now, cfg: cfg.tripwire, tape }).slice(0, 2);
    for (const x of trips) { lastTrip.set(x.coin, now); journal('TRIPWIRE', x); }
    return trips;
  }

  async function tick() {
    if (busy || stopped || state.ended) return; busy = true;
    try {
      const tk = tickers(); const now = clock();
      fillOrders(tk); manage(tk);
      if (now >= state.endsTs) { const ret = (equity(tk) / state.startingUsd - 1) * 100; if (ret >= cfg.extendIfUpPct) { state.endsTs = now + cfg.extendHours * 3600_000; state.extensions = (state.extensions ?? 0) + 1; journal('EXTENDED', { returnPct: r2(ret), endsTs: state.endsTs }); log(`SOCRATES TRADER is up ${r2(ret)}% — he stays on for another ${cfg.extendHours} h (extension ${state.extensions}), now ending ${new Date(state.endsTs).toISOString().slice(0, 16)}Z`); saveState(); } else { finish(tk); return; } }
      if (!settleWindows(tk)) return;
      if (!keyPresent) { if (!warnedKey) { warnedKey = true; log('SOCRATES TRADER: ANTHROPIC_API_KEY is not set — the trader waits (no model call is possible); stops on held coins still run'); } }
      else {
        refreshAlbum();
        const shift = onShift(); if (shift !== lastShift) { lastShift = shift; log(shift ? `SOCRATES TRADER DAY SHIFT begins (${shiftText()}): hunting — scans, tripwire and new buys are on` : `SOCRATES TRADER DAY SHIFT ends: no new buys until ${shiftText()} — he guards what he holds (stops, trail, half off, fills); no scans, no model spend on empty hours`); }
        const trips = shift ? tripwire(tk) : [];
        if (trips.length) { lastScan = now; lastHold = now; log(`SOCRATES TRADER TRIPWIRE: ${trips.map((x) => `${x.coin} +${x.jumpPct}% (${x.tradesLastMinute ?? '?'} trades${x.buyShare != null ? `, ${Math.round(x.buyShare * 100)}% buyers` : ''})`).join(', ')} — waking him now`); await scan(tk, trips); }
        else if ((Object.keys(state.positions).length || state.owed.length) && now - lastHold >= cfg.holdCheckEveryMs && now - lastScan >= 20_000) { lastHold = now; await holdCheck(tk); }
        else if (!caged() && shift && now - lastScan >= lookEveryMs()) { lastScan = now; lastHold = now; await scan(tk); }
      }
      saveState();
      if (now - lastSummary >= 10 * 60_000) { lastSummary = now; const s = writeStatus(tickers()); log(`SOCRATES TRADER: equity $${s.equityUsd} (${s.returnPct >= 0 ? '+' : ''}${s.returnPct}%), cash $${s.cashUsd}, holding ${Object.keys(state.positions).join(', ') || 'nothing'}${Object.keys(state.orders).length ? `, resting ${Object.keys(state.orders).join(', ')}` : ''}, ${s.trades} closed trades (${s.wins} won), windows won ${state.cage.won} lost ${state.cage.lost}${caged() ? ' (IN THE CAGE)' : ` (level ${state.cage.level + 1})`}, model spend today $${s.spend.todayUsd} of $${cfg.dailyUsd}`); }
      else writeStatus(tk);
    } catch (err) { log(`SOCRATES TRADER tick failed (contained): ${clip(err?.stack ?? err?.message ?? err, 300)}`); }
    finally { busy = false; }
  }

  function start() {
    if (existsSync(P.state) && state.startedTs) log(`SOCRATES TRADER resumes (${TRADER_BUILD}): equity from state, started ${new Date(state.startedTs).toISOString().slice(0, 16)}Z, ends ${new Date(state.endsTs).toISOString().slice(0, 16)}Z${state.ended ? ` (ALREADY FINISHED: ${state.endReason} — nothing to do)` : ''}`);
    if (!existsSync(P.state)) { saveState(); log(`SOCRATES TRADER starts (${TRADER_BUILD}): $${state.startingUsd} paper account, model ${cfg.model}, spend cap $${cfg.dailyUsd}/day, ${cfg.windowHours} h windows (lose ${cfg.maxLostInARow} in a row and the run ends), limit orders at the ${cfg.makerFeeRate * 100}% maker fee, half off at +${cfg.takeHalfAtPct}%, tripwire +${cfg.tripwire.jumpPct}%/min, auto-trail ${cfg.trail.pct}% from +${cfg.trail.armAtPct}%, album + notebook + tape, ends ${new Date(state.endsTs).toISOString().slice(0, 16)}Z — no Judge; its own ledger at ${P.dir}`); journal('START', { startingUsd: state.startingUsd, endsTs: state.endsTs, model: cfg.model, dailyUsd: cfg.dailyUsd, windowHours: cfg.windowHours }); }
    timer = setInterval(() => { tick(); }, cfg.tickMs); if (typeof timer?.unref === 'function') timer.unref();
    setTimeout(() => { tick(); }, 5_000).unref?.();
  }
  function stop() { stopped = true; if (timer) { clearInterval(timer); timer = null; } try { saveState(); } catch { /* best effort */ } }
  return { start, stop, tick, status: () => writeStatus(tickers()), state: () => state, paths: P, config: cfg, album: () => album };
}

export function readTraderConfig(file) {
  try { if (!existsSync(file)) return null; return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
