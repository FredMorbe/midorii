# Working in the Midorii app

The Midorii desktop app puts the [workspace](workspace.md) in a window and adds the tools you
use every day around it: a watchlist, a command palette, saved layouts, and alerts. This page
describes those. Everything here is kept on your machine.

## The command palette

Press **Ctrl+K** (**Cmd+K** on macOS) to open the palette, then type to filter. It lists:

- every tab, with its shortcut: **Ctrl+1** to **Ctrl+8** jump straight to a tab from anywhere;
- the theme switch;
- on the Chart tab, **Change market…**, your saved layouts, and the markets on your active
  watchlist.

Press **Enter** to run the highlighted row and **Esc** to close.

## The watchlist

Open **Watchlist** from the panel buttons in the chart's top bar. It lists the markets you
follow with their last price and how far they moved since the previous daily close. Click a row
to put that market on the active chart.

- Press **+** to add a market. Use the list's menu to create, rename, or delete lists, and to
  add a section heading that groups markets.
- Drag a row or a section to reorder it.
- The panel only subscribes to prices while it is open, so a closed watchlist costs nothing.

Markets on a watchlist also come first in the symbol search, marked with ★. The markets you
opened last follow, marked with ↺.

The watchlist is for the live chart. On a replay or bot chart, which is tied to its session,
the panel says so instead of switching the market.

## Layouts

A layout is the whole Chart tab: the grid, every chart's market and timeframe, its indicators,
and its drawings. Open **Layouts** in the chart's top bar to save the current arrangement under
a name, load a saved one, or delete it with the trash button on its row. The command palette
offers the same actions.

Loading a layout replaces the charts. The app's own overlays, such as the account card and the
alert lines, are not part of a layout and stay as they are. An open paper position stays open.

## Panels side by side

The Watchlist and the Alerts panels can be open together. They sit next to each other and the
chart makes room. Which panels are open is remembered, like the widths you drag.

## Alerts

Open **Alerts** from the same panel buttons. The panel lists every alert you have and has a
switch on each row to pause it. Click a row to edit it. Alerts are watched in the background on
their own market, whatever the chart shows, for as long as the app is open. When one fires you
get a notification, a sound, and a toast. An alert on a market without a live feed cannot be
set.

### Price alerts

Right-click the chart and choose **Add Alert**. The alert is a dashed line at that price. Drag
the line to move it, or click the ✕ on its tag to delete it. It fires when the price crosses the
level, either way or in one direction.

### Indicator alerts

Right-click the chart and choose **Add Indicator Alert…**, or press **+** under *Indicator
alerts*. Pick one of the standard indicators, adjust its settings, and choose the timeframe.
The alert fires when the indicator crosses a level, such as the RSI above 70, or crosses the
price, such as a moving average falling through it.

### Percent alerts

Press **+** under *Percent alerts*. The alert fires when the price has moved by the share you
choose, up, down, or either way. The move is measured from the first price seen once the alert
is on. A repeating alert measures its next move from where it fired.

### Time alerts

Press **+** under *Time alerts* for a reminder at a moment. Enter a span from now, such as
`15m`, `1h30m`, or `2d`, or a clock time such as `14:30`, which means the next time the clock
shows it. A reminder fires once. If it came due while the app was closed, it fires at the next
start and says so.

### Once, repeating, and the pause

Each alert fires **once** and then switches itself off, or repeats. A price that wobbles around
a level can cross it again and again within seconds, so a repeating price, indicator, or
percent alert takes a **pause after firing**: one minute for new alerts, or any of none, five
minutes, fifteen minutes, or an hour. A crossing during the pause is not reported later.
Alerts made before the pause existed have none until you set one.

### History

Every alert that fires is also listed under *History* in the Alerts panel, with when it fired.
The list keeps the last 100 entries until you press **Clear**. Click an entry that belongs to a
market to show that market on the chart.
