# NQ AMD wick presets

The Strategies tab includes **NQ AMD Wick 1m** and **NQ AMD Wick 3m** for historical
research. They preserve two tested configurations. Neither meets the research target
of a win rate above 50%, and neither has passed an independent final test.

Restart a running build after this update to load the new strategy catalogue. Saved
settings survive that restart.

A wick beyond one edge of a confirmed range freezes its boundaries. A close strictly
through the midpoint in the opposite direction confirms an entry. The sweep candle
can itself confirm; an order can fill no earlier than the next candle's open. No fair
value gap is required. Candles sweeping both edges are skipped because their price
sequence is unknown. Missing bars cannot connect the range and its confirmation.

Both presets use five minimum range bars, two touches per edge, a 12-bar confirmation
window, a 100-point stop, a 1.5R target and a 600-bar maximum hold. Compression is 0.8
for 1m and 0.6 for 3m. There is no daily entry maximum and no forced minimum.

Selecting either preset in Backtest sets $200,000 simulated capital, $20 per point
and whole-contract sizing, and selects the archived NQ dataset when it is available.
The default fixed risk is $2,000: one contract with a 100-point stop. If the leverage
ceiling prevents that exact planned risk, the entry is skipped. Costs and stop gaps
can increase the actual loss. Percentage-adjusted historical execution prices are
not rounded to exchange ticks.

Strategy settings persist independently of individual backtest results. These presets
are research only and cannot start trading bots. They do not configure a broker or
change existing bots. Backtests still need the intended date range and cost assumptions.
