# GitCharts — Backlog prossima sessione

## 0. Fix Compare view (PRIORITÀ)
- Compare view (`js/compare.js`) non funziona correttamente
- Ripartire dalla sessione del 2026-04-19 dove abbiamo applicato prune master
  layout (exclude file morti nell'ultimo snapshot) in `app.js` loadTimeline
- Controllare: ghost footprints, sync camera bidirezionale, auto-fit framing,
  consistenza con il nuovo master pruning
- Probabile: compare.js non usa il pruning → mostra ancora fantasmi

## 1. Branch picker da git
- Leggere lista branch remoti via `git ls-remote --heads <url>` (già esiste helper
  `get_develop_branch` in `server.py`: riusare + generalizzare)
- Endpoint `GET /api/branches?repo=<name>` → array branch
- UI: nel modal Regenerate, dropdown "Branch" popolato dai branch reali invece
  di hardcoded "main" / "develop"
- Il file di output usa come suffix il nome branch (es. `-feat-auth-hotspot.json`)
- `generate_repos_list.py` riconosce i nuovi suffix automaticamente

## 2. Timeline con "daily git history"
- Oggi il timeline parte dal commit più vecchio della branch e finisce al HEAD
- Volere: usare date assolute (1 snapshot/giorno reale), includere anche i giorni
  senza commit (stato identico al giorno precedente)
- Riuso granularity=day già implementata, ma allineare sulla timeline calendario
  (ogni X giorni compare uno snapshot, senza buchi)

## 3. Rimuovere wireframe inutili
- Ci sono edge lines (`THREE.EdgesGeometry`) sui building alti in `city.js`
  (riga ~365 circa: `if (h > 2.5 && bw > 1.2 && bd > 1.2) edges`)
- L'utente non capisce a cosa servono → rimuovere, valutare se sostituire con
  subtle ambient occlusion o nulla
- Verificare anche i "district borders" (thin strips emissive) che marcano i
  top-level districts: tenerli o toglierli?

## 4. Confronto main vs develop (vista statica affiancata)
- Nuova view "Compare" o toggle che mostra 2 canvas affiancati:
  - left: city main (ultimo commit)
  - right: city develop (ultimo commit)
- Camera sincronizzata (stesso orbit)
- Highlight visuale sui building che hanno:
  - `score_dev > score_main` → alone rosso (peggioramento su develop)
  - file nuovi in develop → edificio blu/verde
  - file rimossi in develop → ghost grigio
- Insights panel diff: lista top 5 file peggiorati + top 5 nuovi hotspot develop

## 5. Rework estetico
- Sfondo: NON marrone, NON notte nera. Qualcosa tipo giorno nuvoloso / blue hour
  leggero, tono pulito. Proposte: `#d6dce4` (light blue-grey), `#e8ecf0` (off-white),
  o morning gradient soft blu→bianco
- Sole: da arancione basso a luce diurna soft con ombre più nette
- Ground asfalto: alleggerire il marrone/scuro verso grigio medio
- Rimuovere la HemisphereLight con tinte seppia, usare tinte neutre o blu freddo
- Scegliere palette coerente (3-4 toni) invece di mix calde/fredde random

## 6. Finestre su grattacieli/case
- Texture procedurale con griglia finestre sugli edifici alti
- Canvas texture: piccoli rettangoli chiari/scuri random = finestre illuminate/spente
- Applicare solo sulle facce laterali (non sul tetto) via UV mapping o 4 materiali
- Bias: edifici alti = grattacieli (griglia fitta), edifici bassi = case (1-2 finestre)
- Di notte/sera: finestre emissive gialle random accese (già tematicamente forte)

## 7. Fumo — più naturale
- **Velocità**: ridurre la velocità salita (`pos[k*3+1] += 0.22` → provare 0.08-0.1)
- **Distribuzione**: ora ogni sorgente emette dal centro del building. Sparpagliare
  emissione su più punti del tetto (es. 3-5 punti random per building) così il fumo
  sembra uscire da più camini/bocchettoni
- **Life cycle**: aumentare durata (`ages += 0.012` → 0.005), aggiungere fade out
  smooth via alpha per age
- **Wispy look**: size più variabile, opacity randomizzata per particella
- Rendere il fumo meno verticale, più "che si allarga e disperde" con vento leggero

## 8. Rimuovere lampioni
- Eliminare blocco lamp pole + bulb in `city.js` (cerca `Street lamps at top-district corners`)
- Riempire vuoto con altro? Valutare se aggiungere qualcosa alle intersezioni o
  lasciarle libere

## 9. Strade
- Verificare che le strade (gap tra building) si vedano chiaramente dopo il
  cambio tema
- Se con asfalto più chiaro si mescola col ground, definire bordi più netti
- Opzione: aggiungere marciapiedi sottili (thin strip) lungo i perimetri dei
  building per separare visivamente building da strada

## 10. Meteo dinamico basato sulla "gravità" del repo
- Toggle button (es. "Weather: off/auto") nella top bar o sotto la city
- Gravity score della repo: aggregato da insights — es. numero hotspot critici,
  % file con score > p90, ratio changes/LOC globale
- Mapping fase meteo:
  - `sunny`: 0-20% hotspot critici → cielo azzurro, sole brillante, nessuna nuvola
  - `partly_cloudy`: 20-40% → qualche nuvola bianca sparsa, sole visibile
  - `overcast`: 40-60% → cielo uniforme grigio chiaro, nessun sole diretto
  - `storm`: 60-80% → nuvoloni grigio scuri, lampi occasionali (flash emissivo
    bianco breve), ombre attenuate
  - `apocalypse`: >80% → cielo nero, fulmini rossi, rain particles fitte,
    shadow super dark
- Tecnica Three.js:
  - Cielo = plane semisfera (hemisphere geometry) con shader gradient dinamico
  - Nuvole = piani con texture canvas + alpha, drift lento sopra la city
  - Pioggia = THREE.Points con posizioni a caduta (gravity downward)
  - Lampi = directional light flash 0.1s ogni X secondi casuali
- Performance: tutto opt-in, skippa raycast o nuvole quando off
- Idea narrativa: meteo cambia DINAMICAMENTE durante timeline playback in base
  allo score di quel momento → vedi la tempesta addensarsi mentre il codice
  marcisce, poi schiarirsi se qualcuno fa refactoring. Molto potente.

## 11. Smoothing transizioni timeline (growth animato)
- Problema attuale: click slider N → updateCityMetrics applica nuovi valori
  istantaneamente → building appaiono/scompaiono di colpo o crescono a scatti
- Volere: interpolazione lineare tra stato snapshot N e snapshot N+1
- Implementazione:
  - Estendere `updateCityMetrics` in `city.js` per accettare `prevMetrics` e
    `tweenMs` (es. 500ms)
  - Per ogni building: salvare scale.y iniziale + target, salvare color base +
    target
  - Animate loop esegue lerp(current, target, elapsed/tweenMs) ogni frame
  - Quando arriva il prossimo tick timeline, fa push del nuovo target anche se
    il precedente non è ancora completo (prende lo stato attuale come start)
  - Color transition: `mesh.material.color.lerp(targetColor, t)`
  - Scale: `mesh.scale.y = THREE.MathUtils.lerp(startY, targetY, eased)`
- Per building che appaiono (prima invisibile → visibile): scale.y parte da 0,
  cresce al valore target → effetto "grattacielo che spunta dal terreno"
- Per building che scompaiono: fade via scale.y → 0 con easing
- Ease-out cubic per naturalezza
- Interval di playback da 600ms → considerare 1000ms per dare respiro al tween
- Se l'utente trascina manualmente lo slider rapido, saltare il tween
  (apply immediate)

---

## Nota tecnica
Tutti i cambi estetici in `js/city.js`. Timeline/branch logic in
`hotspot_analysis.py` + `server.py`. Compare view è una nuova feature
che probabilmente vuole un nuovo modulo `js/compare.js` + pulsante 4°
accanto ad Archaeology/Hotspot/City.

Backlog prioritario (ordine che darei):
1. Tema pulito (biggest impact estetico) + cleanup wireframe/lampioni
2. Smoothing timeline transitions (ostacolo attuale alla percezione growth lineare)
3. Fumo più naturale
4. Finestre sui building
5. Daily history allineata al calendario
6. Branch picker
7. Meteo dinamico basato su gravity (feature narrativa potente)
8. Compare main vs develop
