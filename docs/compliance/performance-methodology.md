# Performance calculation methodology

This engineering methodology requires review by finance/compliance counsel before public performance presentation.

## Separation and labels

Never aggregate Live, Paper, backtested, or other hypothetical results into one statistic. Every view labels mode, agent/strategy version, gross or net, fee/slippage inclusion, data source/freshness, benchmark, date range, sample size, and whether deposits/withdrawals are time-weighted. Demo values are synthetic and not performance evidence.

## Portfolio return

Use time-weighted return when evaluating strategy performance across external cash flows: geometrically link subperiod returns split at each cash flow. Money-weighted return may be shown for user experience only when labeled and its numerical method/convergence documented. Never annualize an unrepresentative short period without conspicuous explanation.

Net performance deducts actual broker-reported fees and known platform/advisory fees. Paper/backtest results use documented transaction-cost, spread, slippage, latency, liquidity, partial-fill, corporate-action, dividend, assignment/exercise, and tax exclusions. Missing costs make a result gross, not net.

## Metrics

- P&L uses reconciled fills/positions and explicit realized/unrealized separation.
- Maximum drawdown is peak-to-subsequent-trough on the selected return series.
- Volatility states sampling interval and annualization assumption.
- Win/loss counts define the unit (closed position/trade) consistently.
- Profit factor appears only with adequate observations and complete loss data.
- Benchmark comparison uses the same dates/cash-flow treatment and verified benchmark data.

Backtests use point-in-time universes/data, prevent look-ahead/survivorship leakage, separate training/selection/test periods, and retain deterministic code/data versions. No metric implies a guarantee, forecast, suitability, or protection from loss. Material methodology changes create a new version and prevent silent historical recomputation.
