# Backtest-Audit — Midorii

**Stand:** 2026-09-18 · **Version:** 0.7.0 + Unreleased · **Branch:** main

> **Update 2026-09-18:** Die nummerierten Befunde (1.1–3.7) sind bearbeitet, mit Status pro
> Abschnitt unten. Die Erweiterungen in Abschnitt 4 (A–N) sind Vorschläge für künftige Arbeit,
> keine Fixes — dort hat sich nichts geändert. Gate: `typecheck`, `lint`, `test` (3106 Tests,
> alle Dateien), `build` — alle vier grün.

Gelesen: `shared/engine/backtest.js`, `shared/engine/broker.js`, `shared/engine/summary.js`,
`shared/analysis/sweep.js`, `shared/strategies/risk.js`, `app/renderer/backtest/*` (Form, Sweep-Runner,
Worker, Trade-Review), `app/renderer/strategies/*` (Registry, Detection-Cache, alle acht Strategien),
`app/renderer/bot/BotRunner.ts` + `botContext.ts` (Parität), `app/electron/data/store/runStore.js`.

Baseline: `backtest-runner`, `sweep-runner`, `sweep-math`, `broker-point-value`, `backtest-trade-review`
— 5 Dateien / 54 Tests grün. Die Befunde 1.2, 2.1 und 2.2 sind mit Skripten gegen die echte Engine
reproduziert (`.scratchpad/bt-audit-probe*.mjs`).

---

## 0. Was trägt

Die Engine ist in ihren Grundentscheidungen richtig und gut begründet:

- **Next-Bar-Regel** ohne Hintertür für Strategien (`fillNow` ist nur für Replay erreichbar).
- **Intrabar-Auflösung** über 1m-Bars statt Raten; `fill.resolution` sagt, was galt.
- **Events nach `index`, nicht `startIndex`** — Look-ahead ist per API nicht verfügbar.
- **Train/Test-Split** im Sweep, Ranking mit `minTrades`, Detection-Cache pro Abschnitt.
- **R wird beim Entry fixiert** (`riskPerUnit`), nicht am letzten Stop gemessen.
- Ein Run speichert die **tatsächlich berechneten Kosten** und den Punktwert, nicht die Overrides.
- Der Store kondensiert die Equity-Kurve und lässt Order-/Fill-Logs weg — kein Speicherproblem.

Die Befunde unten sind Randfälle und fehlende Modellierung, keine Konstruktionsfehler.

---

## 1. Hoch

### 1.1 Kosten und Punktwert sind im Backtest nicht einstellbar — jeder Run läuft mit Crypto-Defaults

> **Status: teilweise behoben am 2026-09-18.** Der Broker kennt jetzt `pointValue`,
> `sizeStep`, `minSize` (rundet Größen wie `ProjectXController.snapSize`, verweigert unter
> dem Minimum) und `feePerUnit` als zusätzliches, additives Kostenmodell neben `feeRate`.
> `runBacktest` gibt `pointValue`/`sizeStep`/`minSize` im Ergebnis zurück, dieselbe
> Begründung wie bei `costs`. Im Backtest-Formular gibt es jetzt einen „Instrument"-Block
> (Punktwert, Size-Step, Min-Size) im selben Advanced-Bereich, in dem zuvor schon ein
> Kosten-An/Aus-Schalter ergänzt worden war (nicht von mir — bereits im Arbeitsstand). Beides
> ist für Einzel-Lauf und Sweep verdrahtet, mit Tests in `test/broker-fills.test.ts`.
> Nicht gemacht: automatisches Vorbefüllen aus Provider-/Datensatz-Metadaten (ProjectX
> `tickValue`, Capital `dealingRules`) — dafür fehlt eine Zuordnung Datensatz→Vertrag im
> Code, die ich nicht erfinden wollte. Die Felder sind manuell zu setzen.

`backtestView.ts:833` und `sweepRunner.ts:226` übergeben `broker: { balance }` und sonst nichts.
Damit gilt für jeden Run:

- `feeRate 0,1 %` des Notionals pro Seite, `spreadPct 0,02 %`, `slippagePct 0,02 %` (`broker.js:42`)
- `pointValue 1` (`broker.js:139`)

Sechs der acht Strategien sind auf Index-Futures geschrieben (Central-Time-Sessions, ES-Referenzen
in `rsiDip.ts`, `openingRange.ts`, `morningBook.ts`). Für NQ/ES ist das dreifach falsch:

1. **P&L ohne Multiplier.** Ein Punkt NQ ist 20 $, hier 1 $. Alle Beträge, Drawdowns und
   Gebühren sind um den Faktor 20 (ES: 50) zu klein — nur `returnPct` und `winRate` überleben
   das, alles Absolute nicht.
2. **Gebühr als Notional-Prozent.** 0,1 % auf 1 Kontrakt NQ bei 20 000 = 20 $ pro Seite statt
   ~1,50 $ Kommission. Die Kostenseite ist ~13× zu hoch, gleichzeitig ist der Notional wegen
   `pointValue 1` 20× zu klein — die Zahl ist in beide Richtungen falsch.
3. **Bruchteil-Kontrakte.** `positionSize()` und `equity·maxLeverage/price` liefern z. B. 0,37
   Kontrakte. Es gibt keine Rundung auf `sizeStep`. Der Bot (`ProjectXController.ts:264`) rundet
   ab — Backtest und Bot handeln also verschiedene Größen mit derselben Strategie.

Der Broker kann Punktwert schon (`setPointValue`, getestet in `broker-point-value.test.ts`), und
die Provider liefern die Metadaten (`projectx.meta` → `tickSize`/`tickValue`, Capital →
`dealingRules`). Nur der Backtest fragt nie danach.

**Empfehlung:** Instrument-Block im Formular (Punktwert, Tick, Size-Step/Min, Kommission pro
Kontrakt und Seite, Slippage in Ticks), vorbefüllt aus Dataset-Meta bzw. Provider, gespeichert im
Run. Siehe Erweiterung A.

### 1.2 `maxDrawdownPct` ist falsch berechnet

> **Status: behoben am 2026-09-18.** Zwei unabhängige Maxima in `backtest.js`. Test in
> `test/backtest-runner.test.ts` reproduziert exakt das Beispiel oben (2.500 Cash-Drawdown
> vs. 10 % als schlimmster Prozentwert von einem früheren, kleineren Rückgang).

`backtest.js:206–211` aktualisiert den Prozentwert nur, wenn der **Cash**-Drawdown einen neuen
Rekord setzt. Ein früherer, kleinerer Cash-Rückgang von einem niedrigeren Peak kann prozentual
größer sein und geht verloren.

Reproduziert: Equity 20 000 → 18 000 (−10 %) → 30 000 → 27 500 (−8,3 %). Engine meldet
`maxDrawdown 2500`, `maxDrawdownPct 0,083`. Richtig wäre 0,10.

Betrifft jede Strategie mit Prozent-Risiko (Compounding), die Stats-Kachel, die Titelleiste, die
`SweepStats` jeder Kombination und die Sortierung in den Sweep-Tabellen.

**Fix:** zwei unabhängige Maxima führen (`dd > maxDrawdown` und `dd/peak > maxDrawdownPct`).
Zwei Zeilen; Test dazu.

### 1.3 Die Out-of-Sample-Prüfung verschluckt ihren Warm-up

> **Status: teilweise behoben am 2026-09-18.** `runBacktest` kennt jetzt `tradeFrom`: Bars
> davor füttern Serien/Events als echten Vorlauf, zählen aber nicht als gehandelt (kein
> Fill, kein Trade, kein Equity-Punkt). Der Sweep nutzt das für den Test-Abschnitt — dessen
> Bars laufen jetzt ab dem Anfang des GESAMTEN geladenen Zeitraums (nicht nur ab dem
> Split), mit `tradeFrom` auf den Split-Zeitpunkt gesetzt. Das behebt exakt den
> reproduzierten Fall: RSI-Dip o. ä. bekommt im Test-Abschnitt echten Vorlauf statt leerer
> Bars. Tests in `test/backtest-runner.test.ts` (tradeFrom direkt) und
> `test/sweep-runner.test.ts`. Nicht behoben: der Einzel-Lauf lädt weiterhin keinen Vorlauf
> vor `from` — dafür bräuchte es eine Vorlauflänge pro Strategie, die nirgends im Code
> deklariert ist (RSI-Dip 200 Sessions, andere weniger), und ein geratener fester Wert wäre
> für manche zu kurz, für andere unnötig teuer. Bewusst nicht geraten.

`sweepRunner.ts:262` baut die Strategie für den Test-Abschnitt aus **nur** den Test-Bars:
`buildStrategy(id, params, testBars, testCache)`. Detektoren mit langem Fenster rechnen ihre
Historie damit aus dem Nichts:

- RSI-Dip braucht 200 Sessions für die SMA — ein 30 %-Test-Abschnitt eines Halbjahres hat ~40.
- ORB/VWAP/Morning-Book brauchen N Sessions für relatives Volumen bzw. ATR.

Ergebnis: OOS meldet 0 oder wenige Trades. In der Tabelle sieht das aus wie „hält nicht stand",
tatsächlich konnte die Strategie nicht anlaufen. Die Aussage, für die der Split existiert, wird
damit für genau die Strategien unlesbar, bei denen sie am wichtigsten ist.

Derselbe Effekt trifft den Einzel-Run am Anfang des gewählten Zeitraums (`warmupBars` wird
zwar gemeldet, aber ein Nutzer, der „ab 1. März" wählt, bekommt Trades ab Mai).

**Fix:** `runBacktest` bekommt `tradeFrom` (Zeit oder Index). Detection und Serien laufen über
alle Bars, `start` = max(Warm-up, tradeFrom-Index), Equity-Kurve und Stats zählen ab dort. Der
Sweep baut Test-Runs über `bars` mit `tradeFrom = cut`; der Einzel-Run lädt Vorlauf
(N Tage vor `from`) und handelt ab `from`.

---

## 2. Mittel

### 2.1 Die pessimistische Reihenfolge hängt von der Platzierungsreihenfolge ab

> **Status: behoben am 2026-09-18.** `_fillAgainst` läuft jetzt zu einem Fixpunkt: pro
> Durchlauf wird nur die schlechteste Order ausgeführt, dann wird neu geranked — sobald der
> Entry gefüllt hat, existiert die Position, gegen die Stop/Target korrekt eingestuft
> werden. Test in `test/broker-fills.test.ts` prüft beide Platzierungsreihenfolgen
> (Stop-zuerst und Target-zuerst) und verlangt in beiden Fällen den Stop-Loss als Ergebnis.

`_adverseRank` (`broker.js:719`) liest `this.position` zur **Sortierzeit** — bevor der Entry im
selben Pass gefüllt ist. Auf der Bar, die Entry, Stop und Target zugleich berührt, ist die
Position noch null, alle Ränge sind 0, und die Sortierung ist die Einfügereihenfolge.

Reproduziert: Market-Entry auf Bar 0, Bar 1 berührt Stop (90) und Target (120).

- `submitEntry` (Stop vor Target platziert) → Stop füllt. Richtig, aber zufällig.
- Dieselben Orders per `ctx.order`, Target vor Stop → **Target füllt**. Optimistisch.

Heute latent: keine Strategie im Repo platziert Exits von Hand. Die API erlaubt es aber, und der
Kommentar über `_fillAgainst` verspricht „never in the strategy's favour".

**Fix:** In `_fillAgainst` Fills, die eine Position öffnen, zuerst ausführen und die verbleibenden
Kandidaten danach gegen die dann existierende Position ranken (zweiphasig). Test mit beiden
Platzierungsreihenfolgen.

### 2.2 Eine ganze Bar ohne Schutz nach jedem Entry mit Bracket (pessimistischer Pfad)

> **Status: behoben am 2026-09-18.** Dieselbe Fixpunkt-Schleife wie 2.1 prüft eine frisch
> angehängte Bracket-Order sofort gegen den Rest desselben Schritts. Dabei kam eine zweite,
> eigenständige Ungenauigkeit zutage: die Gap-Prüfung verglich den neuen Level gegen den
> ursprünglichen Bar-Open statt gegen den tatsächlichen Fill-Preis des Entries — das erzeugte
> einen unplausiblen Gap-Fill, wenn der Bar-Open zufällig unter dem neuen Stop lag, obwohl
> der Markt beim Faktischen Entry längst höher stand. Behoben über eine laufend
> aktualisierte `referencePrice` in `_fillAgainst`. Ein bestehender Strategie-Test
> (`opening-range-strategy.test.ts`) beruhte an einer Stelle auf der alten (großzügigeren)
> Bracket-Verzögerung; die Fixture wurde minimal angepasst (Bar-Open über den kommenden
> Stop gelegt), ohne die eigentliche Testaussage zu ändern. Tests in
> `test/broker-fills.test.ts` und `test/backtest-runner.test.ts`.

`_attachBracket` dokumentiert es: die Bracket-Legs werden beim Fill platziert und sind erst im
**nächsten** Step live. Alle acht Strategien nutzen `ctx.order({ bracket })`, nicht `submitEntry`
— das betrifft also jeden Trade.

Reproduziert (ORB-Muster): Stop-Entry 105, Bracket `stopDistance 5`. Die Fill-Bar fällt danach
auf 70. Geplanter Verlust 5, realisiert **33** (Stop füllt am nächsten Open bei 72).

Auswirkung nach Modus:

- Fine fills an, Basis 1m, Timeframe ≥ 5m: eine Minute ungeschützt. Klein, aber bei jedem Trade.
- Strategie **auf der Basis-Timeframe** (1m auf 1m-Daten) oder Fine fills aus: die volle Bar.
  Eine 1m-Strategie ist damit systematisch ungeschützt auf ihrer Entry-Bar — und das ist das
  Setup, das ein Bot live fährt.

**Fix:** Nach einem Entry-Fill in `_executeOrder` die frisch platzierten Bracket-Legs gegen den
**Rest desselben Steps** prüfen, pessimistisch (Stop zuerst; bei Gap-Open ist der Fill schon das
Open, also Rest = Bar ohne Open). Das ist konservativ und entspricht dem, was ein Exchange-OCO im
Handel tut. Die Konvention „nie auf der platzierenden Bar" bleibt für Strategie-Orders bestehen;
Bracket-Legs sind keine Entscheidung der Strategie auf dieser Bar, sondern Teil des Entries.

### 2.3 Der Sweep-Split schneidet mitten in eine Bar

> **Status: behoben am 2026-09-18.** Neue Funktion `alignSplitToBars` in `sweepRunner.ts`
> rundet den Cut vorwärts auf den Start der nächsten tatsächlich vorhandenen Bar. Tests in
> `test/sweep-runner.test.ts` (Alignment direkt, plus eine Prüfung, dass der Cut im
> Sweep-Ergebnis immer exakt auf einer Bar-Zeit liegt).

`splitRange` (`sweep.js`) rundet `cut` auf Millisekunden, nicht auf die Timeframe. `sliceBars`
ist halboffen auf `bar.time`, also:

- die letzte Train-Bar (time < cut, Ende > cut) ist ganz im Train — ihr Close liegt hinter dem Cut;
- ihre 1m-Sub-Bars werden aber bei `cut` abgeschnitten (`sliceBars(baseBars, …, cut)`), d. h.
  ein Stop/Target in den fehlenden Minuten wird auf dieser Bar **nicht** gesehen, obwohl
  `resolution: 'intrabar'` gemeldet wird.

Einmal pro Sweep, deterministisch. **Fix:** im Runner `cut` auf ein Vielfaches von `stepMs` ab
`from` runden, bevor gesliced wird.

### 2.4 Bot und Backtest teilen die Strategie, nicht den Kontext

> **Status: teilweise behoben am 2026-09-18.** `BotRunner` ruft `strategy.init` jetzt genau
> einmal pro Start, gegen die erste Bar, für die der Bot tatsächlich läuft — mit einem Flag,
> da der Bot `strategy` anders als der Backtest bei jeder Bar neu baut. Tests in
> `test/bot-runner.test.ts` (einmalig, kein Retry bei Fehler, erneut nach Stop/Restart).
> `onFinish` bewusst NICHT verdrahtet: der Bot hat kein Äquivalent zu "die Daten sind zu
> Ende" — er läuft oder wird von einer Person gestoppt, und die Stop-Methode dokumentiert
> explizit "a stopped bot has not stopped DECIDING... nothing was closed". `onFinish` beim
> Stoppen auszulösen würde diese Garantie durchbrechen, sobald eine Strategie es einmal
> nutzt. Der Paritätstest (Bot vs. Backtest, identische Order-Folge) aus der Erweiterungsliste
> (G) wurde nicht gebaut — das bleibt offen.

`botContext.ts` ist eine zweite Implementierung von `history`/`value`/`events`/`order`. Zwei
Abweichungen heute:

- Der Bot ruft `strategy.init` und `onFinish` nie (`BotRunner.ts:497–534`). Aktuell definiert
  keine Strategie eines — sobald eine es tut, verhält sie sich live anders als im Test.
- Der Bot baut die Strategie **auf jeder Bar neu** über die gesamte Historie. Korrekt, aber
  jede Detektion läuft pro Minute komplett — bei 200-Session-Fenstern spürbar.

Es gibt keinen Test, der eine Strategie einmal durch `runBacktest` und einmal Bar-für-Bar durch
`botContext` treibt und dieselben Orders erwartet. **Empfehlung:** genau diesen Paritätstest
für alle acht Strategien (Erweiterung K), dann kann der Kontext gemeinsam werden.

### 2.5 Kein Margin- und Liquidationsmodell

> **Status: nicht behoben.** Bewusst — eine echte Zwangsglattstellung bräuchte eine
> Margin-Anforderung pro Instrument (Prozent des Notionals o. ä.), die nirgends im Code
> spezifiziert ist. Ein geratener Standardwert wäre für jede Instrumentenklasse falsch.
> Das ist eine Produktentscheidung, keine reine Code-Änderung.

`maxLeverage` geht bis 100. Der Broker kennt keine Margin: Equity kann negativ werden, offene
Positionen werden nie zwangsgeschlossen, `positionSize` verweigert nur neue Trades ab
Equity ≤ 0. Ein Futures-/CFD-Konto wäre lange vorher liquidiert. Für `maxLeverage 1` irrelevant,
darüber schönt es Ergebnisse — ausgerechnet im Sweep, der Hebel mit variieren kann.

### 2.6 Limit-Orders füllen bei Berührung

> **Status: teilweise behoben am 2026-09-18.** Broker-Option `limitFillMode: 'touch'|
> 'through'` (Default `'touch'`, unverändertes Verhalten). `'through'` verlangt
> `low < limit` / `high > limit` statt `<=`/`>=`; ein Gap durch den Level füllt in beiden
> Modi gleich. Stop-Orders sind unverändert (Berührung ist per Definition ihr Trigger).
> Getestet in `test/broker-fills.test.ts`. Nicht gemacht: UI-Schalter im Backtest-Formular
> — dieselbe Begründung wie beim ausgelassenen Teil von 1.1, keine sichere visuelle
> Verifikation in dieser Sitzung möglich.

`_triggerPrice` füllt ein Limit, sobald `low <= limitPrice`. Keine Queue-Position, kein
Durchhandeln nötig. Standardannahme, aber die optimistische; Silver Bullet (Limit-Entry am FVG)
und jedes Take-Profit profitieren davon. Nicht dokumentiert, nicht wählbar. **Empfehlung:**
Option „Limit füllt nur, wenn der Preis durch das Level handelt" (`low < limit` statt `<=`,
bzw. mit Sub-Bars: ein späterer Sub-Bar-Close jenseits des Levels).

---

## 3. Niedrig

- **3.1** `loadBars` lädt Basis-Bars bis `to + DAY` mit der Begründung, eine offene Position
  könne „gegen echte Bars zu Ende laufen" (`backtestView.ts:774`). `makeSubBarLookup` liest
  nur Minuten innerhalb der Spanne einer Strategie-Bar; alles nach der letzten Bar ist tot.
  Real hilft der Zusatztag nur der letzten Bar, wenn `to` mitten in ihr liegt.
  **Status: behoben am 2026-09-18** — Kommentar korrigiert, beschreibt jetzt die tatsächliche
  Funktion (Sicherheitsmarge für `makeSubBarLookup`s letztes Bar-Fenster), nicht das
  Force-Close, das der Engine explizit widerspricht.
- **3.2** Einzel-Run speichert `to = letzte Bar`, Sweep `to = letzte Bar + step`. Zwei Runs
  derselben Range sind in der Library nicht auf den Blick vergleichbar.
  **Status: behoben am 2026-09-18** — `SweepRun.to` meldet jetzt die letzte Bar-Zeit statt
  der intern für `sliceBars` nötigen exklusiven Grenze; die Sweep-eigene Slicing-Logik
  bleibt unverändert korrekt, nur was gespeichert/angezeigt wird, ist jetzt konsistent.
- **3.3** Keine direkten Broker-Fill-Tests: Gap-Fills am Open, Sibling-Cancel, Reversal,
  Trailing-nach-Fill, Hedging-FIFO sind nur indirekt über `live-session` und
  `silverbullet-detector` abgedeckt. `broker.js` hat 1 400 Zeilen und einen 100-Zeilen-Test.
  **Status: behoben am 2026-09-18** — neue Datei `test/broker-fills.test.ts` (20 Tests):
  Gaps, Sibling-Cancel, Reversal, Hedging-FIFO, Trailing-nach-Fill, plus die 2.1/2.2/2.6-Fixe
  und Size-/Fee-Instrumentierung. Nicht erschöpfend, aber die genannten Lücken sind zu.
- **3.4** `ctx.history(n)` alloziert pro Aufruf ein Slice. Strategien, die es pro Bar rufen,
  kosten auf einem 1m-Jahr im Sweep messbar. Ein Ring-View oder `bar(back)` wäre billiger.
  **Status: nicht behoben** — bewusst. Ohne die API zu brechen (ein echtes Array, das eine
  Strategie halten und später lesen darf) lässt sich die Kopie nicht vermeiden; das wäre ein
  Redesign von `ctx.history`, kein Bugfix, und niemand hat danach gefragt.
- **3.5** Sweep-`progress.etaMs` extrapoliert linear; bei gemischten Detection-Keys ist die
  erste Hälfte oft die teure. Kosmetisch, im Code als ehrlich markiert. Kein Fix nötig — der
  Befund selbst sagt das schon.
- **3.6** `docs/user/` hat keine Seite zum Backtester (Regeln, Fill-Modell, Kosten, Split).
  Die Erklärungen stehen ausschließlich in Code-Kommentaren.
  **Status: nicht behoben, bewusst zurückgestellt.** `docs/` und `README.md` sind Velas
  eigene, öffentliche Dokumentation der Charting-Bibliothek — nicht Midoriis. Es gibt im
  Repo überhaupt keine bestehende Stelle für app-eigene Nutzer-Doku (Backtest, Bots, Replay);
  eine Seite einfach unter `docs/user/` einzuhängen würde Zielgruppen vermischen (öffentliche
  Bibliotheks-Doku vs. private Trading-App). Wo Midorii-Doku hin soll, ist eine Entscheidung,
  keine Fleißarbeit — daher ausgelassen statt geraten.
- **3.7** Look-ahead-Sicherheit hängt vollständig an der `index`-Disziplin jedes Detektors und
  daran, dass keine Serie zentriert glättet. Die Engine kann das nicht erzwingen; es gibt keinen
  generischen Test dafür (siehe Erweiterung K).
  **Status: behoben am 2026-09-18** — siehe Erweiterung K unten.

---

## 4. Erweiterungen — priorisiert

Reihenfolge nach Nutzen für die Frage „kann ich diesem Ergebnis trauen?", dann Aufwand.

### A. Instrument-Spezifikation (behebt 1.1) — **zuerst**

Ein `Instrument`-Objekt pro Markt: `pointValue`, `tickSize`, `sizeStep`, `minSize`, Kommission
pro Kontrakt/Seite **oder** als Notional-Prozent, Slippage in Ticks **oder** Prozent, optional
Margin pro Kontrakt. Quellen: Dataset-Meta (Import-Dialog fragt danach), Provider-Meta
(ProjectX `tickValue`, Capital `dealingRules`), manuell im Formular. Der Broker rundet
Größen auf `sizeStep` und verweigert < `minSize`; das ist dieselbe Regel wie im Bot.
`Costs` bekommt `feePerUnit` neben `feeRate`. Der Run speichert das Instrument.

### B. Kosten-Sensitivität

Denselben Run mit 0×, 1×, 2× Kosten (Detektion ist gecacht, das kostet Sekunden). Drei Zahlen
nebeneinander sagen mehr über eine Edge als jede Kennzahl: eine Strategie, die bei 2× kippt,
lebt von der Kostenannahme.

### C. Walk-Forward statt eines Splits

Rollierende (oder verankerte) Train/Test-Fenster; pro Fenster die beste Kombination, OOS-Equity
über alle Fenster zusammengesetzt. Baut auf `runSweep` auf (Ranges, Cache, Ranking existieren).
Mit 1.3 gelöst ist das der natürliche nächste Schritt.

### D. Robustheit im Sweep

- 2D-Parameteroberfläche (Heatmap) für zwei gewählte Achsen — ein Plateau ist ein Fund, eine
  Spitze ist Rauschen. `results` trägt schon jede Kombination.
- Nachbarschafts-Score: Median der Metrik über die ±1-Schritt-Nachbarn statt Bestwert; als
  Ranking-Metrik anbieten.
- Optional volle OOS für alle Kombinationen (heute nur best/worst — bewusst, aber als Schalter).

### E. Monte-Carlo über die Trade-Reihenfolge

Bootstrap der geschlossenen Trades (mit Zurücklegen, N=1000): Verteilung von MaxDD,
Wahrscheinlichkeit eines Drawdowns > X, Konfidenzband der Equity. Reine Arithmetik über
`trades[]`, gehört nach `shared/analysis/`, läuft im Sweep-Worker.

### F. Kennzahlen, die fehlen

In `summary.js` bzw. `analysisFigures.ts`:

- Sharpe/Sortino auf Tagesreturns der Equity-Kurve, Calmar (Return/MaxDD), Recovery-Faktor
- Drawdown-Dauer (längste Zeit unter dem Peak), Time in Market
- Monats-/Wochentag-/Stunden-Tabelle (Session-Strategien leben davon)
- R-Verteilung (Histogramm) — `riskPerUnit` ist da, wird aber nur gemittelt
- **MAE/MFE pro Trade**: braucht Extremwert-Tracking im Broker während der Position. `_trail`
  verfolgt `extreme` schon, das Muster ist da. MAE ist die eine Zahl, die sagt, ob der Stop
  richtig sitzt.

### G. Parität Bot ↔ Backtest (behebt 2.4)

Ein Test pro Strategie: dieselben Bars, einmal `runBacktest`, einmal Bar-für-Bar durch
`botContext` mit `Broker` als Konto; erwarte identische Order-Folge. Dann `init`/`onFinish` im
Bot nachziehen und den Kontext in `shared/` zusammenführen.

### H. Sessions und Kalender

Feiertags-/Half-Day-Kalender für CME (rsiDip nennt das Problem explizit), Settlement-Zeiten,
Overnight-Finanzierung für CFD (Capital) und Funding für Perps (Bybit/Hyperliquid). Ohne das
sind Multi-Tages-Halte auf CFD/Perps systematisch zu gut.

### I. Reproduzierbarkeit und Vergleich

- Run speichert Daten-Fingerprint (Hash über Bars) und App-Version; „Erneut laufen lassen" aus
  der Library, mit Hinweis, wenn die Daten sich geändert haben.
- Zwei Runs nebeneinander: Equity-Overlay, Stats-Diff. Die Library hat die Daten, die Ansicht
  fehlt.

### J. Export und Abgleich mit Live

Trades/Equity als CSV. Umgekehrt: Bot-Account einer Periode gegen den Backtest derselben
Periode legen → gemessene Slippage und Fill-Abweichung pro Trade. Das ist der einzige Weg,
die Kostenannahmen aus A zu kalibrieren statt zu schätzen.

### K. Look-ahead-Guard (behebt 3.7)

Generischer Test über alle Strategien: Detektion über Bars[0..i] und über Bars[0..n] müssen bis
`index ≤ i` identische Events und Serienwerte liefern (Präfix-Invarianz). Findet jeden
Detektor, der nach vorn schaut oder zentriert glättet, ohne den Detektor lesen zu müssen. Dazu
ein Stichproben-Assert im Sweep-Worker (jede 50. Kombination, ein zufälliges i).

> **Status: umgesetzt am 2026-09-18** (ohne den Sweep-Worker-Teil). Neue Datei
> `test/strategy-lookahead.test.ts`: 45 Tage synthetischer 5-Minuten-Bars, fünf
> Präfix-Schnitte, für jede der acht registrierten Strategien. Verglichen werden Serienwerte
> exakt und Event-Identität (`index`+`startIndex` — genau die Felder, auf die sich die
> Engine laut ihrer eigenen Dokumentation verlässt). Bewusst NICHT das volle Event-Payload:
> `sessionEndIndex` (Opening Range) und vergleichbare Felder in `intradayWindows.ts` sind
> laut Kommentar im Quellcode als „letzte bisher gesehene Bar der Session" definiert — das
> darf und soll sich zwischen einem Präfix- und einem Voll-Lauf unterscheiden, das ist kein
> Blick nach vorn, sondern genau das Verhalten, das ein wachsender Bot braucht. Ergebnis:
> sechs von acht Strategien werden echt geprüft und bestehen; RSI-Dip (200-Sessions-Vorlauf)
> und TBR9 finden auf den 45 Tagen nichts und werden sichtbar (per `console.warn`, kein
> Fehlschlag) als ungeprüft markiert — ehrlich statt stillschweigend grün. Der
> Sweep-Worker-Stichprobenteil wurde nicht gebaut; der Test deckt dieselbe Aussage bereits
> ohne Worker-Integration ab.

### L. Parallele Sweeps

`runSweep` ist worker-neutral. Kombinationen auf `navigator.hardwareConcurrency` Worker
verteilen, gruppiert nach Detection-Key, damit der Cache pro Worker greift. Der Sweep-Client
fasst die Teilergebnisse zusammen. Faktor 4–8 auf üblichen Maschinen.

### M. Strategien außerhalb des Repos

Alle Strategien sind TypeScript im Repo. Ein Skript-Interface (der `ScriptingEngine`-Port
existiert für Indikatoren) für `onBar(ctx)` würde den Backtester für Nutzer öffnen. Größer;
setzt A und K voraus, sonst testet ein Nutzer mit falschen Kosten und ohne Look-ahead-Schutz.

### N. Multi-Symbol / Portfolio

Eine Strategie über mehrere Märkte mit einem Konto; Korrelation der Equity-Kurven. Der Broker
ist single-instrument (Position ohne Symbol) — größter Umbau der Liste, deshalb zuletzt.

---

## 5. Vorgeschlagene Reihenfolge

1. **1.2** (zwei Zeilen), **2.3** (Rundung), **2.1** (zweiphasiges Ranking) — kleine Engine-Fixes mit Tests.
2. **2.2** Bracket gegen den Rest der Fill-Bar — die eine Änderung mit messbarer Wirkung auf jede Strategie.
3. **1.3 + A** — `tradeFrom` und Instrument; danach sind Absolutbeträge und OOS-Zahlen erstmals lesbar.
4. **K + G** — Look-ahead-Guard und Paritätstest, bevor weitere Strategien dazukommen.
5. **F, B, E, D** — Kennzahlen und Robustheit, jeweils reine Arithmetik über vorhandene Daten.
6. **C, L, H, I, J** — Walk-Forward, Parallelisierung, Kalender, Vergleich, Export.
7. **M, N** — Öffnung und Portfolio.
