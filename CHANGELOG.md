# Changelog e mappa del progetto

> **Leggimi per primo.** Questo file esiste per chiunque riprenda in mano
> questo progetto — persona o assistente AI (Claude o altro) — così da capire
> rapidamente cosa è stato fatto, perché, e dove sono le trappole note, senza
> dover rileggere tutta la cronologia chat o riscoprire gli stessi errori.
>
> **Regola per chi lo aggiorna**: ogni volta che si fa una modifica non
> banale al progetto, aggiungere una voce in cima alla sezione "Log" (più
> recente in cima), con data, cosa è cambiato, perché, e il commit
> corrispondente. Non riscrivere la cronologia passata — solo aggiungere.

---

## ⚠️ Trappole note — leggere prima di correggere qualsiasi bug

Questo progetto è stato creato con emergent.sh (backend Python + MongoDB) e
poi migrato quasi interamente a Netlify Functions + Supabase. **I vecchi
file Python sono ancora nel repo come codice morto** — editarli non ha
alcun effetto sull'app reale. Due volte in una singola sessione (25 luglio
2026) un bug è stato corretto per errore nel file legacy prima di essere
trovato e corretto in quello vero:

| Componente | File VERO (usalo) | File LEGACY (morto, non toccarlo) |
|---|---|---|
| Motore Poisson/strutturale | `netlify/functions/lib/clusterEngine.ts` (chiamato da `predict.ts`) | `backend/cluster_engine.py` |
| Chiamate LLM/AI | `netlify/functions/lib/llmProviders.ts` (chiamato da `ai-predict.ts`) | `backend/server.py` |
| Tutto il resto dell'API | `netlify/functions/*.ts` | `backend/server.py` |

**Metodo generale per non ricadere nella trappola**: prima di editare un
bug "lato backend", aprire `netlify.toml` e controllare se l'endpoint
coinvolto ha un redirect verso `/.netlify/functions/*`. Se sì, il file
giusto è dentro `netlify/functions/`, non `backend/`.

Altre cose da sapere subito:
- Il **deploy è automatico**: push su `main` → GitHub Action → build hook
  Netlify → live in 1-2 minuti. Nessuna azione manuale necessaria.
- Il vecchio backend Emergent (`match-quota-analyzer.emergent.host`) non è
  più chiamato da nessuna parte dell'app (sganciamento completato il
  24/07/2026).
- Repo GitHub reale collegato a Netlify: `lavorosm1-tech/emergent-app`.

---

## Architettura in breve

- **Frontend**: Expo / React Native — `frontend/`
- **Backend**: Netlify Functions (TypeScript) — `netlify/functions/*.ts`
- **Database**: Supabase, progetto "emergent-app-db" (id `zjucgmngettxfwgxazxl`)
- **Motore pronostici**, 3 sistemi indipendenti fusi in
  `frontend/src/api.ts` → `buildFinalVerdict()`:
  - **STRUTT** — Poisson puro, `netlify/functions/lib/clusterEngine.ts`
  - **AI** — LLM esterno (DeepSeek/Groq), `netlify/functions/ai-predict.ts`
    + `lib/llmProviders.ts`
  - **PRE** — euristica sulle quote, `frontend/src/api.ts`
    (`quickPredictionFamily` / `rankPicks`)
- **Storico/apprendimento**: tabelle Supabase `market_scores` +
  `family_counters` (per famiglia+mercato+campionato), alimentate sia dai
  risultati inseriti in-app sia dal backfill storico (vedi log 25/07).
  Tabella separata `match_results_training` con le partite storiche grezze
  importate da ScoreBlast (non usata direttamente dal motore, solo come
  fonte per il backfill).

---

## Regole per chi lavora su questo repo

**Risparmio crediti di build.** Ogni deploy di produzione costa ~15 crediti e il
piano ne da' 1.000 al mese: circa 66 build. Sul vecchio account 73 deploy hanno
esaurito il ciclo. Quindi:

1. **`[skip ci]` in fondo al messaggio di commit** per tutto cio' che non deve
   andare online subito: correzioni minori, refactoring parziali, testi,
   commenti, aggiornamenti di questo CHANGELOG. Il deploy vero si fa quando una
   funzionalita' e' completa — accorpando piu' commit in una sola pubblicazione.
2. **Ignore command in `netlify.toml`**: se un commit tocca solo file `.md`,
   `docs/`, `.gitignore` o `LICENSE`, la build viene annullata da sola. E' una
   rete di sicurezza per quando ci si dimentica del punto 1, non un sostituto.

Logica dell'ignore: e' un comando di shell, **exit 0 = build annullata**,
**exit 1 = build eseguita**. `git diff --quiet` esce 0 quando non trova
differenze, quindi confrontando i due commit ed escludendo la documentazione,
"nessuna differenza vera" significa "non serve costruire". Se
`CACHED_COMMIT_REF` e' vuoto (prima build, o cache svuotata) si costruisce
sempre, per non rischiare di saltare un deploy necessario.
Verificato su un repo di prova: solo `.md` -> annulla; codice -> costruisce;
codice + `.md` insieme -> costruisce.

## Log (più recente in cima)

### 2026-09-19 — «Non mi carica i file Excel»: l'import funzionava, era muto

**Cosa succedeva davvero.** L'import Excel **non era rotto**. Verificato sul sito in
produzione: `/upload-skipped` riportava l'ultimo caricamento di pochi minuti prima —
`calcio base per data (4).xlsx`, 137 righe lette, 137 valide, 0 scartate. Il file
arrivava, veniva letto e scritto. Solo che l'app non diceva niente e la lista non
cambiava, quindi sembrava che non caricasse.

**Causa.** In react-native-web `Alert.alert` e' una funzione **vuota**:
`class Alert { static alert() {} }`. Su web — cioe' nel browser, nella PWA installata
e dentro il guscio Android, che carica il sito — ogni `Alert.alert` spariva nel nulla.
Erano **41 messaggi in 8 schermate**: esiti, conferme e soprattutto ERRORI. Nel caso
dell'import, con 0 righe scartate si finiva proprio sul ramo
`Alert.alert("Import completato", ...)`, l'unico senza alternativa per il web
(il ramo con gli scarti un `window.confirm` ce l'aveva gia').

**Correzioni.**
- Nuova `notify(title, message?)` in `src/utils/platform.ts`: `window.alert` su web,
  `Alert.alert` su nativo. Tutti i 41 `Alert.alert` convertiti; i tre casi con piu'
  pulsanti (uscita dall'app, azzeramento apprendimento, import con scarti) passano a
  `confirmAction`, che era gia' cross-platform. Nessun `Alert.alert` resta fuori da
  `platform.ts`, e gli import ormai inutili sono stati tolti.
- **Cache invalidata dopo l'import**: `matchesCache.invalidate()` e
  `daysCache.invalidate()` (a `daysCache` mancava il metodo, aggiunto). Senza, dopo
  aver caricato l'Excel la lista continuava a mostrare i dati di prima e le giornate
  nuove non comparivano nella striscia dei giorni: il secondo motivo per cui sembrava
  che l'import non avesse fatto niente.

**Nota su questo import specifico**: `inserted 0, updated 0, unchanged 137` significa
che quelle 137 partite erano gia' nel database con le stesse identiche quote — il file
era gia' stato caricato. Non e' un errore.

Verifiche: `tsc` 0 errori, eslint 0 errori, `npm run build:web` verde, e i test a
runtime del motore (`buildFinalVerdict` alle quattro soglie) invariati.

### 2026-09-18 (2) — Tasto "Genera Multipla": il motore compone la schedina

**Cosa**: in Strumenti → ANALISI, nuovo tasto **Genera Multipla** (schermata
`/multipla`). Rossi imposta giorno, numero di partite (1-8) e quota totale
minima; il motore sceglie da solo le giocate più probabili del giorno in modo
che il prodotto delle quote arrivi alla quota chiesta, e le mette in Schedina.

**Regole decise da Rossi (18/09)**:
- campionati **a scalare**: prima le sette leghe principali (ING1, ITA1, SPA1,
  GER1, FRA1, OLA1, POR1), poi i secondari (altre prime divisioni, Serie B /
  Championship / 2. Bundesliga e le altre seconde dei paesi principali, coppe
  europee), poi i minori. Si scende di livello solo quando quello sopra è
  finito. `netlify/functions/lib/leagueTier.ts`. NON è la lista del tasto
  PRINCIPALI (che ha anche NOR1/USA1/SVE1/DAN1): per la multipla vale quella stretta;
- pavimento di probabilità per gamba **45%**; soglia per gamba = `min_odd`
  delle Impostazioni; massimo **2 partite per campionato**;
- minimo 1 partita (una singola è una multipla da 1).

**Come sceglie** (`netlify/functions/build-multipla.ts`, deterministico):
1. per ogni partita del giorno senza risultato e non ancora iniziata (ora
   italiana), `structuralAnalysis` + `giocateAmmissibili`: tutte le giocate in
   whitelist, coerenti col ranking, sopra soglia e sopra il pavimento. La prima
   è il pick del motore, le altre sono le alternative;
2. riempimento livello per livello, dentro il livello la più probabile prima;
3. se la quota totale non basta, si alza una gamba alla volta scegliendo lo
   scambio che **costa meno probabilità**: prima l'alternativa sulla stessa
   partita, poi la sostituzione con un'altra partita, sempre a scalare;
4. se la quota non è raggiungibile, risponde `ok: false` con il motivo e la
   migliore schedina trovata: **mai** gambe sotto il pavimento per arrivare al numero.

**Scarti**: ogni gamba ha "Altro pronostico" (prossimo mercato del ranking,
stessa partita), "Altra partita" (esce, entra la migliore rimasta partendo
dal livello 1) e "No campionato" (escluso per oggi). Le altre gambe restano
**bloccate** (`locked`) e il server ricompone solo il buco. Gli scarti
sopravvivono alle rigenerazioni finché non si cambia giorno o si preme
"Rigenera da zero".

**Salvataggio**: "Metti in Schedina" → `apply: true`: svuota la Schedina (se
lo switch è acceso), marca `selected`, scrive `pick_finale`/`pick_finale_prob`
come fa `save-verdict` (mai su partite concluse), così la pagella misura
anche le multiple.

**Quote stimate**: multigol e combo hanno la quota stimata dal motore (il
file Sisal non le fornisce), come nel dettaglio partita: restano giocabili,
marcate con la tilde `~`, e la quota totale è "~" finché ne contiene una.
Prima versione le scartava e 7 partite su 14 uscivano "non giocabili".

**Motore**: `selezionaPick` ora è `giocateAmmissibili(...)[0]`: stessa logica,
stesso risultato (verificato con quote finte alle quattro soglie, 16 casi
identici a prima). `giocateAmmissibili` restituisce TUTTE le giocate
ammissibili in ordine di ranking.

**Routing**: `build-multipla` registrata nei tre posti (`api/[route].ts`,
`vercel.json`, `netlify.toml`). Frontend: `api.buildMultipla`, tipi
`MultiplaRequest/Response/Leg`, schermata `frontend/app/multipla.tsx`. Il
vecchio tasto TypingMind resta, rinominato "Multipla via TypingMind (esterna)".

**IA**: non usata. "Le più probabili dato N e Q" è un problema di numeri che il
motore ha già; l'IA, se mai, entrerà a scegliere dentro una rosa già valida
(fase 3 del piano del 18/09). Lezioni già pagate: ignora le soglie, inventa quote.

**Verifica**: eseguita davvero con un finto PostgREST e 14 partite su tre
livelli: 6@14 → 6 di livello 1 quota 14,46; 2@3,5 → 3,65; 1@2 → O2.5 @2,10
al 46%; 5@13 → 15,54 con max 2 ING1; 2@50 → `ok:false` con motivo; scarti +
gamba bloccata rispettati; `apply` → 5 PATCH corrette. `tsc` 0 errori,
`build:web` ok. Il DB vero non è raggiungibile dalla sandbox di Claude:
prima prova con dati reali da fare in app.

### 2026-09-18 (2) — Layout: la pagina finiva sotto le barre di sistema

**Sintomo riferito da Rossi**: nella Schedina non si riusciva a scorrere e il tasto
indietro non si vedeva, "per uno spostamento".

**Causa**: le meta PWA aggiunte poche ore prima (voce A8). `viewport-fit=cover` dice
al browser di disegnare la pagina anche SOTTO le barre di sistema, lasciando allo
sviluppatore il compito di compensare con `env(safe-area-inset-*)`. In PWA installata
e dentro la WebView Android quella compensazione non arrivava dove serviva:
l'intestazione con il tasto indietro finiva sotto la barra di stato e la BottomNav
sotto la barra dei gesti. Stesso effetto, su iOS, di
`apple-mobile-web-app-status-bar-style: black-translucent`.

**Correzioni** (solo grafica, nessun cambio di logica: motore e fusione riverificati
con gli stessi test a runtime, invariati):
- `frontend/scripts/inject-pwa-head.js`: tolto `viewport-fit=cover` (il valore
  predefinito "auto" tiene la pagina dentro l'area sicura su qualsiasi telefono, con
  o senza tacca) e `black-translucent` sostituito con `black`. Stessa modifica in
  `app/+html.tsx`, per coerenza.
- Aggiunto un blocco `<style id="pb-viewport">` che àncora l'altezza al viewport
  VISIBILE (`100dvh` con fallback `100%`): con il 100% del viewport di layout, sul
  telefono la barra degli indirizzi fa parte dell'altezza e la barra in basso
  finisce sotto il bordo dello schermo.
- `capacitor.config.ts`: `android.adjustMarginsForEdgeToEdge: 'auto'`. Con
  targetSdk 35 Android 15 disegna l'app a tutto schermo, e il valore predefinito di
  Capacitor 7 e' `disable`: nessun margine per le barre di sistema. Richiede un APK
  nuovo (il workflow parte da solo: `capacitor.config.ts` e' nei percorsi che lo
  attivano).

**Omogeneita' fra schermate** — tre misure scritte a mano che davano risultati diversi
su telefoni diversi:
- `quote/[id].tsx` e `risultato/[id].tsx` si posizionavano con
  `paddingTop: insets.top + 8` (e `+ 10` nello stato di caricamento: la pagina
  saltava quando i dati arrivavano) invece di `SafeAreaView edges={["top"]}` come
  tutte le altre. Ora usano SafeAreaView: stessa distanza dall'alto ovunque.
- la barra Salva/Salva-e-avanti di `risultato` stava a `bottom: 96 + insets.bottom`,
  un numero che non coincide con l'altezza vera della BottomNav (58 + inset): fra le
  due barre restava una striscia di sfondo, di 30px su Android e 38 su iPhone. Ora
  usa `useNavMetrics()`, la stessa misura del dettaglio partita.
- tutte le liste avevano `paddingBottom: 130` (200 su quote e risultato), pensato per
  una barra flottante. La BottomNav sta NEL FLUSSO e lo spazio se lo prende da sola,
  quindi quei valori erano un buco vuoto in fondo a ogni lista: portati a 24, e a 96
  dove sopra la nav c'e' davvero una barra assoluta (match, risultato).

Verifiche: `tsc` 0 errori, eslint 0 errori, `npm run build:web` verde con le meta
corrette nel `dist/index.html` generato.

### 2026-09-18 — NG fuori dai mercati giocati, prompt IA riscritto, npm al posto di yarn

**Decisione di Rossi**: NG non lo gioca. Tolto dalla `VERDICT_WHITELIST` in
`clusterEngine.ts` e dalla copia in `frontend/src/api.ts` — le due liste restano
identiche, ora a **17 mercati** (verificato con un confronto automatico).

**Attenzione, problema trovato durante la modifica e corretto nello stesso commit.**
Togliere NG dalla whitelist bastava a non farlo uscire, ma apriva un buco peggiore:
NG non era più fra i candidati, quindi non poteva più *vietare* i mercati opposti.
In una partita difensiva con NG al 61%, appena le alternative finivano sotto
soglia il verdetto scivolava su **GG al 39%** — l'esatto contrario della lettura,
cioè lo stesso difetto corretto il 27/07 su Deportivo Riestra - Boca. In più si
perdeva il rilevamento della famiglia ambigua GG/NG appaiati (caso Nacional
Potosí). Soluzione: `VETO_ONLY_MARKETS` (oggi solo `NG`). Un mercato "solo veto"
**non può diventare la giocata** ma continua a: (a) vietare i mercati che lo
contraddicono e stanno sotto di lui nel ranking, (b) rendere ambigua la sua
famiglia quando è appaiato al proprio opposto. Presente in entrambe le copie
(motore e fusione), da tenere allineato come la whitelist.

Verificato ESEGUENDO davvero le funzioni (non solo compilando) su una partita
difensiva costruita apposta, con NG primo nel ranking al 61% e GG al 39%:
- motore (`selezionaPick`) e fusione (`buildFinalVerdict`) danno lo stesso
  risultato a tutte e quattro le soglie: `MG 2-4 totali @1,62` a 1,40/1,50/1,60,
  **nessuna giocata** a 1,75 (prima della correzione usciva GG @2,05)
- NG non compare mai fra i candidati del verdetto
- la partita offensiva di controllo non cambia comportamento

**Prompt dell'IA riscritto** (`predictionPrompt.ts`, `PREDICTION_SYSTEM`). Era
ancora quello originale a 6 famiglie, scritto prima del catalogo a 54 mercati, e
conteneva due consegne opposte: la FASE 2 suggeriva NG per le famiglie
CHIUSA_PROTETTA e INSTABILE, e la lista finale "Mercati ammessi" (24 nomi, NG
compreso) contraddiceva il catalogo iniettato da `ai-predict.ts`, che dice
"scegli ESCLUSIVAMENTE da questa lista". Il modello seguiva spesso la prima.
Ora: la famiglia resta come lettura descrittiva, spariscono gli ordini di
preferenza per famiglia e la lista finale, ed è esplicito che i mercati si
prendono solo dal catalogo del messaggio utente.

**E soprattutto il filtro nel codice**, perché le istruzioni al modello sono un
suggerimento: `buildMarketTable` in `ai-predict.ts` ora filtra le righe con
`isVerdictMarket()` oltre che con la soglia di quota. L'IA vede **solo** i
mercati che possono diventare la giocata.

**Etichetta nel dettaglio partita**: se `main_prediction` dell'IA cade fuori dai
mercati giocati, sotto il riquadro compare "Proposta IA fuori dai mercati
giocati: non può diventare il verdetto finale", invece di presentarla accanto al
verdetto come se fosse equivalente.

**A6 — deploy riproducibili, con npm.** `yarn install` sull'albero di Expo 54 non
arriva in fondo in ambiente pulito (oltre 40 minuti nella sola risoluzione delle
dipendenze) e `yarn import` rifiuta il lockfile npm moderno, quindi il
`yarn.lock` che l'audit chiedeva non era producibile. Stesso obiettivo raggiunto
con npm: committato `frontend/package-lock.json`, e install/build passati a
`npm ci` / `npm run build:web` in `vercel.json` e `netlify.toml`. Verificato:
`npm ci` da zero installa 968 pacchetti in 15 secondi, `tsc` 0 errori, eslint
0 errori, build web verde. Da qui in poi i deploy usano versioni fissate.

**COSA NON È ANCORA VERO**: il costo della rimozione di NG non è stato misurato
sulle 583 partite di test come si era fatto il 27/07 per la whitelist. Va fatto
rigiocando il test set e scrivendo qui la nuova curva soglia/precisione.

### 2026-09-18 — Identità PronoBlast sul web, PWA, e pulizia del repo (A8, A12)

**A8 — l'app web si chiamava "frontend" e aveva l'icona di Emergent.**
- `app.json`: `name` → PronoBlast, `slug` e `scheme` → `pronoblast`.
- Icone rigenerate da `android/pronoblast-icon-1024.png`: `icon.png`,
  `adaptive-icon.png` (1024), `splash-icon.png` (512), `favicon.png` (64),
  più `public/pronoblast-192.png` e `-512.png` per la PWA.
- `frontend/public/manifest.webmanifest`: nome, colori (#0A0A0A), display
  standalone. `expo export` copia `public/` dentro `dist/` così com'è.
- **Trappola trovata**: con `web.output: "single"` Expo **non usa**
  `app/+html.tsx` — genera `index.html` da un template suo. Le meta della PWA
  lì dentro non arrivavano in produzione. Soluzione: `frontend/scripts/inject-pwa-head.js`,
  lanciato in coda a `yarn build:web`, che imposta `lang="it"`, `viewport-fit=cover`
  e aggiunge manifest, `theme-color`, `apple-touch-icon` e le meta iOS.
  `+html.tsx` è stato aggiornato lo stesso, così è già pronto se un giorno si
  passa all'output statico.

**A12 — codice morto.** Cancellati `backend/` (Python di Emergent, nessun file
vivo lo importava: verificato con `git grep`), `.emergent/`, `memory/`, `tests/`,
`test_reports/`, `test_result.md`, `design_guidelines.json`, `.gitconfig`,
`frontend/scripts/reset-project.js` (e la voce `reset-project` da package.json)
e i loghi React di esempio. `README.md` non diceva più "Here are your
Instructions": ora spiega cos'è l'app, lo stack, i comandi, la regola dei tre
posti in cui registrare una function, e rimanda al CHANGELOG.

Strumenti dopo le modifiche: `tsc` 0 errori, eslint 0 errori / 16 warning,
`yarn build:web` verde con le meta iniettate.

### 2026-09-18 — Correzioni dell'audit: crash, etichette, tema, lint

Applicati i punti A1-A5, A7, A9, A10, A11 dell'ordine di lavoro
`pronoblast-gymbuilder-correzioni-e-piano-multipla.md`. Nessun cambio di logica
del motore: solo difetti che si vedevano a schermo o che bloccavano gli strumenti.

- **A1 (crash)** `confirmAction` era usato in `frontend/app/match/[id].tsx` ma mai
  importato: toccare l'icona di avviso su un'alternativa "vetoed" dava
  `ReferenceError` e schermata bianca. Aggiunto l'import da `@/src/utils/platform`.
- **A2** `f.label` non esiste su `MARKET_FAMILIES` (il campo è `name`): le
  intestazioni dei gruppi di mercati erano vuote in Quote e Risultato.
- **A3** `colors.card` e `colors.background` non esistevano nel tema, quindi
  `backgroundColor: undefined`. Aggiunti in `src/theme.ts` come alias di
  `surface` e `bg` (correzione meno invasiva della sostituzione nei file).
- **A4** definito `styles.helpBtn`, che era usato ma mancante. **In più**: il
  modale `FamilyLegendModal` era importato e il tasto "?" ne accendeva lo stato,
  ma non veniva mai montato nel render — il tasto non apriva niente. Montato.
- **A7** `match.prediction` non esiste sul tipo `Match`: la condizione era sempre
  vera e ricaricava la partita senza motivo. Ora usa `match.main_prediction`.
- **A9** `useSharedValue` era chiamato dentro un `if` in `useBottomNav`
  (violazione delle regole degli hook). Spostato prima di ogni return.
- **A10** i 4 errori eslint (`react/no-unescaped-entities`, hook dentro `if`)
  sono a zero; tolte le variabili inutilizzate citate nell'audit (`oX`,
  `probDi`, `direzione`, `Linking`, `isGrid`); `_NoExtras` è un'asserzione di
  tipo a compilazione e resta, con `eslint-disable-next-line` e motivazione.
- **A11** `backdropFilter` in `Toast.tsx` non è uno stile React Native: ora è
  applicato solo quando `Platform.OS === "web"`.
- Corretto anche l'unico errore TS rimasto fuori elenco: `window.fetch &&` in
  `api.ts` era una condizione sempre vera (TS2774).
- **A5** `.metro-cache` (3.626 file, 71 MB) tolto dal tracking nel commit
  precedente; la cartella resta sul disco locale.

**Strumenti, prima → dopo**: `tsc` 18 errori → 0; eslint 4 errori / 29 warning
→ 0 errori / 17 warning; `expo export --platform web` verde in entrambi i casi.

**Verifica a runtime** (regola del 27/07, esbuild non intercetta le variabili non
definite): `buildFinalVerdict` eseguita davvero con dati finti alle quattro
soglie 1,40 / 1,50 / 1,60 / 1,75 e in tre casi degenerati (senza IA, senza
pre-pronostico, senza analisi strutturale). Nessuna eccezione; il pick scende
lungo il ranking come previsto (O2.5 @1,72 fino a 1,60, GG @1,85 a 1,75) e NG
resta escluso perché contraddice la direzione.

**Restano aperti** dell'audit: A6 (yarn.lock mancante), A8 (identità PWA e
icone), A12 (codice morto e README), A13 (segreti GitHub e fattura Netlify:
richiedono Rossi), A14 (decisioni di logica).

### 2026-09-18 — APK Android installabile e auto-aggiornante (come GymBuilder)

**Cosa**: PronoBlast si può installare sul telefono come app Android, con lo
stesso meccanismo già in uso su GymBuilder. Documentazione completa in
`docs/android-apk.md`.

- `android/` + `capacitor.config.ts`: guscio Capacitor 7 che carica
  `https://pronoblast.vercel.app`. Il frontend NON è dentro l'APK: ogni
  deploy Vercel arriva da solo nell'app installata.
- `android/app/src/main/java/app/pronoblast/mobile/ApkUpdaterPlugin.java`:
  plugin nativo (copiato da GymBuilder) che legge la versione installata,
  scarica l'APK nuovo con DownloadManager e apre l'installatore.
- `android/app/debug.keystore`: firma debug FISSA committata, così ogni build
  ha la stessa firma e Android accetta l'aggiornamento. Non cancellarla.
- `.github/workflows/build-apk.yml`: compila l'APK e lo pubblica come GitHub
  Release `apk-v1.0.<N>` (link fisso `.../releases/latest/download/PronoBlast.apk`).
  Differenza da GymBuilder: niente APK committato in `public/` e nessun
  `VERCEL_TOKEN` da configurare. Parte solo quando cambia il guscio, o a mano.
- `frontend/src/utils/androidApp.ts` + `frontend/src/components/NativeUpdater.tsx`:
  dentro l'APK confronta la versione installata con l'ultima Release (API
  pubblica GitHub) e propone l'aggiornamento. Nel browser non fa niente.
  Non importa `@capacitor/core`: legge `window.Capacitor` iniettato dal guscio.
- `Strumenti -> APP ANDROID`: tasto "Installa App Android" (nel browser
  Android scarica l'APK, su desktop apre la pagina della Release; nascosto
  dentro l'APK).
- `package.json` di radice: aggiunte le dipendenze Capacitor. Vercel continua
  a installare solo `frontend/`.
- Icona originale (PB su sfondo scuro con il gradiente del tema): l'icona
  precedente in `frontend/assets/images/icon.png` era ancora quella di default
  di Emergent. Sorgente 1024px in `android/pronoblast-icon-1024.png`.

Verificato: `tsc` invariato (18 errori preesistenti, nessuno nei file nuovi),
`expo export --platform web` ok. La compilazione Android avviene sul runner
GitHub (qui non c'è l'SDK): prima esecuzione = release `apk-v1.0.1`.

### 2026-09-17 (6) — Nuovo tasto "Genera Multipla tramite AI"

Aggiunto in Strumenti, sezione ANALISI, sopra "Framework TypingMind".

**È il rovescio dell'altro tasto.** Il framework parte dalle partite già in
Schedina e le fa analizzare; questo non tocca la Schedina: copia un prompt fisso
con cui il modello **cerca da solo** le partite del giorno sul web e propone una
multipla da quota 13. Rossi poi seleziona a mano nell'app quelle che gli
interessano.

Il prompt è scritto da Rossi e usato **così com'è**, senza segnaposto né
aggiunte: priorità ai campionati di 1ª divisione con discesa a 2ª e 3ª se non
ci sono partite, mai sotto la 3ª, 5-8 partite, un solo pronostico per partita,
stop appena la quota supera 13.

**Scelta deliberata: la data NON viene passata.** Il prompt chiede al modello di
usare "la data odierna reale", che è più affidabile che infilarci una data
calcolata dal telefono col rischio di fusi orari sbagliati.

Riusa il meccanismo già collaudato dell'altro tasto — scheda aperta PRIMA di
qualunque `await` per non farla bloccare come popup, copia negli appunti,
fallback su `navigator.clipboard`, avviso se il popup viene bloccato.

**Verifiche**: prompt estratto ed eseguito dal bundle, 1.115 caratteri su 15
righe, identico all'originale; `tsc` a 18 errori di baseline, nessuno nuovo;
`expo export` completato.

### 2026-09-17 (5) — Prompt ridotto all'osso: una riga più l'elenco

Rossi ha provato a mano la versione minima — una riga di consegna più l'elenco
con scenario e mercati — e il risultato è stato **migliore di tutte le versioni
con le regole**. Il prompt è stato ridotto a quello.

**Da 5.522 a circa 750 caratteri.**

**Perché le regole facevano danno.** Erano arrivate a 5.500 caratteri con una
regola aggiunta per ogni errore osservato. L'effetto è stato l'opposto: nel test
il modello ha scartato **4 partite su 8** e non ha prodotto nessuna multipla,
usando le regole stesse come appigli — *"la favorita reale è l'altra"* per
aggirare il divieto sul lato, *"quota combo non trovata"* per saltare un
mercato, il pavimento di 1,35 per escludere le doppie chance.

**L'informazione che conta è già nei MERCATI.** Sono calcolati dalle quote reali
del file Sisal — l'unica cosa che il modello non può procurarsi — e restringono
la scelta a due o tre voci per partita. Il resto era testo da rigirare.

**LEZIONE, la più importante di questa serie**: aggiungere una regola per ogni
errore osservato peggiora il risultato invece di migliorarlo. Ogni vincolo in
più è un appiglio in più, e un modello con venti regole trova sempre quella che
gli permette di non decidere. Se torna a sbagliare si aggiunge UNA riga per
quell'errore specifico, non un blocco.

**NOTA**: la versione minima non contiene più l'istruzione sulla multipla a
quota 13. È la richiesta esplicita di Rossi, segnalata: basta una riga per
rimetterla.

**Verifica ESEGUITA**: testo generato con quattro partite su tre scenari
diversi, identico a quello che Rossi aveva composto a mano. 749 caratteri.

### 2026-09-17 (4) — Scartava 4 partite su 8: cinque correzioni

Il test ha prodotto **4 scarti su 8** e nessuna multipla. Analizzando gli scarti
uno per uno, la causa principale non era nessuna di quelle che si sospettavano.

**CAUSA PRINCIPALE — ribaltava chi è la favorita.** Su Sunderland-AZ e
United-Brighton il modello ha scritto *"la favorita reale è AZ"* e *"la favorita
reale è Brighton"*, contro le quote (1,60 e 1,80 sui padroni di casa). Poi ha
invocato il divieto "mai contro la più probabile" per **vietarsi l'1** e
scartare. Due scarti su quattro ottenuti usando una regola per aggirarne
un'altra.

Corretto con una regola esplicita: *la favorita è quella con la quota più bassa,
punto*; frasi come "la favorita reale è l'altra" sono vietate; forma e assenze
servono a scegliere il mercato, non a ribaltare il lato.

**Le quattro correzioni chieste da Rossi:**

1. **In EQUILIBRIO via `1X / X2`, dentro `MG Totale 2-4`** (somma gol fatti fra
   2,0 e 4,0). Le doppie chance in equilibrio sbagliavano il pronostico: non
   c'è una favorita, quindi il lato era una scelta arbitraria.
2. **`1X` e `X2` esenti dal pavimento di 1,35.** Restano solo in Progressione,
   come coperture: a 1,35 non se ne troverebbero quasi mai. Nel test il modello
   aveva scartato Coventry-Villa per un X2 a 1,28.
3. **La combo `GG + Over 2,5` non si scarta più se il book non la espone già
   pronta**: si calcola moltiplicando le due quote reali e togliendo il 5%. È un
   calcolo su quote vere, non una stima. Il modello aveva scritto "quota combo
   non trovata" su tre partite.
4. **Lo scarto è l'ultima spiaggia**, non la via comoda: prima di scartare deve
   verificare di non aver saltato la combo e di non aver ribaltato la favorita.

**LEZIONE**: un divieto può diventare uno strumento di fuga. "Mai contro la più
probabile" era nato per impedire le giocate contro il favorito; il modello l'ha
usato per non scegliere affatto, ridefinendo il favorito a proprio comodo. Ogni
regola che dipende da una definizione va accompagnata da quella definizione,
resa non negoziabile.

**Verifiche ESEGUITE**: i tre scenari rigenerati e controllati — Equilibrio ora
mostra `MG Totale 2-4` al posto delle doppie chance, Gap e Progressione
invariati; blocchi "QUOTA MINIMA" e "favorita" riletti nel testo prodotto.
5.522 caratteri.

### 2026-09-17 (3) — Mercati dettati dallo scenario, condizioni per ciascuno

I divieti dicevano al modello cosa NON fare e lui occupava lo spazio rimasto:
prima 5 Over su 7, poi `1 fisso` su un Manchester United che lui stesso aveva
descritto in crisi. Cambio di impostazione: da divieti a **condizioni
positive**, e mercati **dettati dallo scenario** invece di una lista fissa.

**Ogni partita porta i propri mercati**, gli stessi che Rossi vede nella card
dell'app:

| Scenario | Mercati |
|---|---|
| Gap Tecnico (casa) | `1 fisso` · `GG + Over 2,5` · `MG Casa 2-4` |
| Gap Tecnico (ospite) | `2 fisso` · `GG + Over 2,5` · `MG Ospite 2-4` |
| Progressione (casa) | `MC CASA (1-3) + MC OSPITE (0-2)` · `1X` |
| Progressione (ospite) | `MC CASA (0-2) + MC OSPITE (1-3)` · `X2` |
| Equilibrio | `GG` · `Over 2,5` · `1X oppure X2` |

Un modello che sceglie fra tre non si rifugia sull'Over come faceva scegliendo
fra otto.

**Handicap asiatici tradotti**: `1 AH -0,75` e `1 AH +0,75` non sono su molti
book italiani, e la regola "se non trovi la quota scarta" avrebbe svuotato le
Progressioni. Sostituiti da `MG Casa/Ospite 2-4` e `1X/X2`. Il multigol
combinato `MC CASA + MC OSPITE` resta (scelta di Rossi) solo sulla Progressione.

**Ogni mercato ha ora una condizione d'ingresso verificabile** — bande di gol
fatti e subiti, non opinioni. Il vecchio divieto "mai MG se l'avversaria subisce
più di 2" era **rovesciato** rispetto alla realtà: il discriminante è quanto
segna chi attacca (Barça 4,2 → 7-2), non quanto subisce chi difende. Corretto:
banda 2,0-3,5 per chi segna, almeno 2 subiti dall'avversaria. Con questa,
Leverkusen-Celje diventa finalmente giocabile in MG, come Rossi chiedeva da
giorni.

**Pavimento a 1,35 su ogni gamba**, senza eccezioni: taglia fuori il Barcellona
a 1,06 e il 1X a 1,25 che il modello aveva proposto.

**Obbligo di confronto**: deve valutare TUTTI i mercati indicati e scrivere per
ciascuno se è giocabile, non fermarsi al primo. Aggiunta la regola di coerenza —
se scrive che la favorita è in difficoltà non può sceglierne l'esito secco — e
il divieto della frase «la quota supera 1,35», che è letteralmente come si era
giustificato sul Manchester United.

**In EQUILIBRIO** aggiunto `1X oppure X2` con il lato lasciato al modello, per
coprire 0-0 / 1-0 / 2-0 che GG e Over lasciavano scoperti. Vincolato ai casi di
partita bloccata, altrimenti sarebbe diventato il nuovo rifugio.

**Verifiche ESEGUITE**: sei partite costruite apposta per coprire tutti e cinque
gli scenari — Gap casa, Gap ospite, Progressione casa, Progressione ospite,
Equilibrio — tutti classificati correttamente coi mercati giusti per lato.
Partite senza le tre quote non ricevono scenario. 4.947 caratteri.

### 2026-09-17 (2) — Scenario nel prompt, quote obbligatorie, quarto divieto

Nel test precedente il modello aveva messo **5 Over 2.5 su 7 gambe** e portato
la multipla a quota **76** partendo da una soglia di 13. Tre cause distinte,
tre correzioni.

**1. Lo scenario accanto a ogni partita.** Le quote reali del file Sisal sono
l'unica cosa che il modello non riesce a procurarsi da solo (i bookmaker si
difendono dai robot), e da quelle sappiamo già che TIPO di partita è. Ora ogni
riga porta `GAP TECNICO` / `PROGRESSIONE` / `EQUILIBRIO` più i mercati da
valutare per primi.

**Non gli passiamo le quote**: sarebbe il circolo vizioso che ci è già costato
il prompt lungo. Gli passiamo una **classificazione** — una parola, non un
numero da confrontare con se stesso. Stessa regola della card in app
(`getScenarioNote`), coi mercati tradotti in quelli ammessi per TypingMind: il
DNB diventa 1X/X2, il multigol 1-3/0-2 diventa MG 2-4.

**2. Quote obbligatoriamente vere.** Il modello aveva intestato la colonna
`Quota stimata` e dichiarato "quote indicative basate su medie di mercato":
quel 76 non esisteva. Ora deve indicare bookmaker e fonte, e **se non trova la
quota scarta l'evento**. Vietata per nome la parola "stimata", che era la
formula con cui si autorizzava.

Conseguenza a catena: senza quote vere il divieto "mai contro la favorita" non
poteva funzionare, perché chi è la favorita lo decide la quota. Su Sunderland-AZ
il modello aveva deciso da sé che il favorito era l'AZ ("imbattuto da 18 gare")
e giocato il 2.

**3. Quarto divieto: mai Over 2.5 se la somma dei gol fatti è sotto 2,5.**
Chiuse le altre tre porte, l'Over era diventato il rifugio: proposto anche su
Coventry-Villa, dove 0,0 + 1,0 fa un gol a partita.

**Aggiunte due regole minori**: fermarsi appena la quota supera 13 (era arrivato
a 76 con sette gambe), e considerare l'esito secco come prima scelta quando la
favorita sta fra 1,50 e 2,20 — il divieto vietava di giocarle contro ma niente
obbligava a considerarla, e il modello scappava sull'Over.

**CORREZIONE A UNA MIA AFFERMAZIONE**: nell'anteprima mostrata a Rossi avevo
scritto che Sunderland-AZ e United-Brighton sarebbero uscite `PROGRESSIONE`.
Eseguendo il codice con le quote reali sono invece **GAP TECNICO**: in entrambe
la X vale esattamente 4,00, e il confine è `X >= 4,00`. Avevo dato per scontato
X < 4 senza controllarlo. Per Sunderland il risultato coincide comunque con
quello che Rossi voleva (`1 fisso`).

**Verifiche ESEGUITE**: le 8 partite reali del 16/09 classificate una per una;
confine testato a X=3,90 (Progressione) e X=4,00 (Gap); favorita ospite in
entrambi gli scenari (dà `X2`/`MG Ospite` e `2 fisso`); equilibrio. Partite
senza le tre quote non ricevono scenario invece di riceverne uno inventato.
3.893 caratteri.

### 2026-09-17 — Tre divieti nel prompt, dopo l'analisi di tre errori reali

Il prompt corto ha funzionato, ma tre pronostici sono andati male e ognuno per
un motivo diverso e ripetibile:

| Partita | Scelta | Esito | Causa |
|---|---|---|---|
| Barcellona-Racing | MG Casa 2-4 | 7-2 | Il Barça segnava 4,2 gol a partita: range sbagliato |
| Milan-Benfica | GG | 0-2 | Milan 2 gol in 4 gare, Benfica 4 clean sheet su 5 |
| Sunderland-AZ | X2 | 1-0 | Ha puntato **contro** il favorito |

**Il terzo è il più istruttivo.** La regola c'era già nel prompt, ma era scritta
**con una condizione**: "se la favorita paga troppo poco, cambia mercato".
Sunderland pagava 1,67 — non "troppo poco" — e il modello si è sentito
autorizzato a giocare X2. Ora è incondizionata: MAI, a nessuna quota.

**LEZIONE**: una regola con una condizione vaga non è una regola. Il modello
trova sempre il caso che sta fuori dalla condizione.

Aggiunti tre divieti assoluti, uno per errore. Aggiunta anche alla tabella dei
pronostici la colonna **media gol fatti e subiti**, così Rossi vede se il
modello ha davvero guardato i numeri prima di scegliere.

**Scartata la proposta alternativa** (che il modello stesso aveva suggerito come
post-mortem): scheda tecnica obbligatoria con xG per ogni partita, tabella di
soglie per mercato, checklist finale SÌ/NO. Motivi:
- "se mancano formazioni ufficiali → ESCLUSA" avrebbe escluso ogni partita non
  imminente, visto che le formazioni escono un'ora prima;
- una tabella con celle obbligatorie da riempire è un invito a inventare gli xG
  mancanti — lo stesso difetto che ci era costato il prompt lungo;
- una checklist di autocertificazione riceve sempre "sì";
- reintroduceva il "max 2 eventi stesso campionato/orario" che Rossi aveva
  fatto togliere;
- le soglie erano ritagliate a posteriori su tre partite già giocate.

I tre divieti usano invece dati che il modello trova davvero sul web — gol
fatti, gol subiti, porte inviolate — non xG stimati per ogni campionato.

**Verifiche ESEGUITE**: prompt generato e controllato riga per riga; ognuno dei
tre errori verificato contro il divieto corrispondente (Barça 4,2 > 3 → MG
vietato; Milan 0,5 < 1 e Benfica 4 clean sheet → GG vietato due volte;
Sunderland favorito → X2 vietato senza eccezioni). 1.416 caratteri, nessuna
quota nel testo.

### 2026-09-16 (4) — Prompt TypingMind riscritto da zero: corto e senza quote

Rossi ha provato a mano un prompt di sei righe, senza quote, con la ricerca web
attiva: **risultato migliore di tutto l'apparato matematico** che avevamo
costruito nei giorni precedenti. Il prompt lungo è stato cancellato e sostituito
con quello.

**I due difetti del prompt lungo, emersi nei test e non sanabili riscrivendo
il testo:**

1. **CIRCOLO VIZIOSO.** Ricevendo il CSV delle quote, il modello ricavava le
   "fair odds" da quelle stesse quote. Confrontare un listino con se stesso
   privato del margine dà una somma di edge sempre pari a MENO il margine: il
   value non può esistere, mai, su nessuna partita. Gli edge positivi che
   comparivano erano errori di arrotondamento. Verificato sul caso
   Sunderland-AZ: le sue fair odds (1.75 / 3.80 / 4.55) sommavano **105,4%** di
   probabilità invece di 100 — erano quote col margine ancora dentro,
   etichettate come fair.
2. **QUOTE INVENTATE.** Sulla stessa partita ha consigliato `X2 @ 1.85` mentre
   nel CSV c'era **2.10**, costruendoci sopra un edge del +8,9%.

**Cosa c'è ora**: giorno, ora, campionato e squadre. Nient'altro. Le quote le
cerca il modello sul web insieme a forma, gol e assenze, così il suo giudizio
nasce da dati **indipendenti** dal listino invece che dal listino stesso.

Cancellati fair odds, Edge%, Kelly, matrice di correlazione, `Σ log`, soglie
per mercato. Sono calcoli che un modello in chat non esegue davvero, e produrre
numeri che sembrano calcoli e non lo sono è peggio che non produrne.

**L'unica regola di sostanza rimasta** è quella che risolve un errore vero
osservato: non puntare contro il risultato probabile, cambiare mercato invece
(niente X2 sul Barcellona a 1.04).

Aggiunta una riga sui dati mancanti: con partite su più giorni, per quelle
lontane le formazioni non sono uscite e il modello deve dirlo invece di
riempire.

Da ~7.000 a ~1.300 caratteri.

**LEZIONE**: più vincoli non significa più qualità. Ogni regola in più è
un'occasione di conflitto, e chiedere a un modello una matematica che non può
eseguire produce numeri decorativi che sembrano risultati. Il prompt corto
scritto da Rossi in cinque minuti ha battuto quello lungo costruito in giorni.

**Verifiche ESEGUITE**: 8 partite (il caso reale) → conteggio, ordinamento e
assenza totale di quote nel testo; 3 partite su 3 giorni e 3 campionati →
"tutte e 3" e date corrette riga per riga; Schedina vuota → risposta vuota
senza errori.

### 2026-09-16 (3) — Tolto anche il limite per fascia oraria

Rossi: se sceglie apposta partite tutte alla stessa ora, il vincolo non deve
bloccarlo. Rimosso `Max 2 gambe stesso slot orario (±90')`, come già fatto per
il campionato.

Entrambi sostituiti da righe **esplicite** ("nessun limite per campionato",
"nessun limite per slot orario") più una riga di sintesi che dichiara il
criterio unico: conta la qualità del pronostico, campionato e orario non
escludono nulla. Le righe esplicite servono perché un elenco di vincoli con dei
buchi porta il modello a inventarsi i limiti mancanti.

**Resta in piedi solo il vincolo di correlazione** (ρ < 0.35), che ha una
ragione diversa: impedisce di giocare due volte lo stesso evento (Over 2.5 e GG
della stessa partita non sono due scommesse, è una scommessa contata due
volte). Quello protegge dal moltiplicare una quota che non esiste, non dalla
concentrazione.

**Verifica ESEGUITA**: caso estremo con 8 partite dello stesso campionato tutte
alla stessa ora — nessun vincolo le esclude più.

### 2026-09-16 (2) — Il prompt nuovo finiva dentro quello vecchio

Rossi continuava a vedere il prompt vecchio anche dopo il deploy. Verificato
interrogando il server in diretta: `/aistudio-prompt` restituiva la versione
NUOVA, corretta. Il problema era nel frontend.

**Causa**: in `selected.tsx`, `book.tsx` e `strumenti.tsx` il testo del server
non veniva copiato così com'è, ma infilato dentro `AISTUDIO_FRAMEWORK`
(`frontend/src/book-content.ts`) al posto del segnaposto `{{CSV}}`.

Quel framework è una consegna **completamente diversa** — "raccoglitore dati
web, usa solo fotmob/footystats/365scores, **non fare EV matematico**", con
formato di output `PARTITA_WEB` / `PARTITA_LLM` — e si aspettava lì una semplice
tabella di quote. Da quando `/aistudio-prompt` genera un prompt completo, negli
appunti finivano **due consegne opposte nello stesso messaggio**, e il modello
seguiva la prima.

**Correzione**: `const filled = csv` nei tre punti. Il testo del server è già
completo di ruolo, processo, formato e disclaimer.

`AISTUDIO_FRAMEWORK` resta nel file, annotato come non più in uso: è un buon
prompt per un lavoro DIVERSO (raccogliere xG, formazioni e assenze in una chat
separata), e se un giorno torna in uso deve ricevere solo la tabella delle
quote.

**LEZIONE — vale oltre questo caso**: riscrivendo il prompt ho guardato solo la
function che lo genera, dando per scontato che il frontend lo copiasse
tal quale. Quando si cambia un contenuto, va seguito **fino al punto in cui
l'utente lo vede**, non fino a dove viene prodotto. Due deploy e due segnalazioni
di Rossi per una cosa che un `grep` sui punti di utilizzo avrebbe trovato
subito.

**Verifiche**: nessun uso residuo dell'involucro nelle schermate; `tsc` a 18
errori di baseline, nessuno nuovo; `expo export` completato.

### 2026-09-16 — Prompt TypingMind: versione definitiva concordata con Rossi

Sostituito integralmente con la specifica "Quantitative Betting Analyst" di
Rossi, approvata dopo averla mostrata in anteprima prima di scrivere codice.

**Adattamenti necessari, discussi e approvati:**
- la specifica era scritta per **due messaggi** ("incolla ora l'elenco nel
  prossimo messaggio"), l'app ne incolla **uno solo**: "nel messaggio
  successivo" → "qui sotto", e "Incolla ora l'elenco" → "ESEGUI ORA
  sull'elenco qui sotto". Senza questo il modello resta in attesa di un
  messaggio che non arriva;
- rimossa la sezione **INPUT ATTESO**: conteneva come esempio le stesse partite
  che poi compaiono davvero in fondo, e un elenco duplicato confonde;
- quota target **≥ 13**, gambe **da 4 a 8**.

**Regola "max 2 gambe stesso campionato" CANCELLATA** su decisione di Rossi:
conta la probabilità migliore, non da quale campionato arriva la partita.
Sostituita da una riga esplicita, perché lasciare il vuoto avrebbe fatto
inventare un limite al modello. Il limite per **slot orario (±90') resta a 2**.

**Copertura obbligatoria** in cima: analizza tutte e N le partite, ognuna nella
tabella A col suo pronostico, anche le escluse. Aggiunta la colonna
`Pick scelto` alla tabella A, che nella specifica non c'era.

Tutti i numeri (N partite, date, elenco campionati) sono **compilati dai dati
veri** della Schedina, non lasciati come segnaposto.

**Verifiche ESEGUITE**: funzione lanciata con le 8 partite reali del 16/09 —
conteggio, date, elenco campionati, ordinamento e CSV corretti; prompt
risultante 7.027 caratteri.

**NOTA PER IL FUTURO**: con il limite di 2 gambe per slot orario, un elenco
concentrato (es. 6 partite su 8 alle 21:00) lascia poche gambe utilizzabili e
il modello risponderà `❌ NESSUNA MULTIPLA VALIDA` con la combinazione da 3-4.
È il comportamento voluto dalla regola, non un difetto — segnalato a Rossi.

### 2026-09-15 (3) — Prompt: tutte le partite analizzate, multipla che si ferma a 13

Rossi ha precisato due regole che la specifica scritta non conteneva:
**tutte** le partite selezionate vanno analizzate (10 selezionate = 10
pronostici), e la multipla deve **fermarsi appena raggiunge quota 13**, con
tante gambe quante servono — 4, 6 o 8, lo decide il modello dalle quote.

Aggiunto in cima al prompt un blocco **"Vincoli di copertura e di chiusura
(prioritari su tutto il resto)"**:

- analizza tutte e N le partite una per una, producendo il pronostico singolo
  anche per quelle che non entreranno nella multipla;
- usa il **minor numero di gambe** che raggiunge la soglia, aggiungendo in
  ordine di EV decrescente e fermandosi appena il prodotto la tocca;
- **se i vincoli strutturali rendono impossibile arrivare a 13, dillo invece di
  forzare** gambe sotto soglia di edge pur di arrivare al numero.

L'ultimo punto è un'aggiunta di Claude: con max 2 gambe per campionato e max 2
per slot orario, su una Schedina concentrata la soglia può essere irraggiungibile,
e un modello lasciato senza istruzioni forzerebbe la risposta.

Nella sezione output ora è preteso l'elenco dei **pronostici singoli per ognuna**
delle N partite, comprese le escluse, col motivo dell'esclusione.

`target_quota` da 15 a **13**. Aggiunto il **Disclaimer** (18+, gioco
responsabile) presente nella specifica aggiornata. Tetto di 8 gambe mantenuto
come limite superiore: il minimo lo decide la soglia.

**Arrotondamento quote a 2 decimali** nel CSV: senza, una quota poteva uscire
come `2.4000000000000004`, rumore inutile per chi legge il prompt.

**Verifiche ESEGUITE**: funzione lanciata con 10 partite disordinate su 9
campionati e 2 giorni — conteggio, elenco campionati, date e ordinamento
corretti; arrotondamento verificato su un valore con coda di virgola.

### 2026-09-15 (2) — Prompt TypingMind sostituito con la specifica di Rossi

Il prompt erano quattro righe ("fai un pronostico, multipla da almeno 13").
Rossi ha scritto una consegna da analista quantitativo — Dixon-Coles, copula per
la correlazione, Kelly — con soglie di edge per mercato, vincoli
anti-correlazione (ρ < 0.35), limiti di esposizione per campionato e slot
orario, e un formato di output preteso. Sostituita integralmente in
`aistudio-prompt.ts`.

**I segnaposto vengono compilati dai dati veri**, non lasciati da riempire a
mano: `{data}` dai giorni delle partite in Schedina, `{lista_campionati}` dai
loro nomi leggibili, `{target_quota}` = 15.

**Scelta consapevole**: la specifica diceva "partite di OGGI", ma le partite in
Schedina hanno la LORO data, che non è detto sia oggi. Usiamo quella: altrimenti
il modello cercherebbe formazioni e assenze per il giorno sbagliato, che su un
prompt che pretende line-up ufficiali è un errore grosso.

**Ordine (richiesto da Rossi).** `pgGet` non garantisce un ordine, quindi le
partite arrivavano sparse — prima una delle 21:00, poi una delle 15:00. Ora
sono ordinate per giorno, orario, competizione e squadra di casa: lo stesso
ordine della Schedina. Aggiunta anche la colonna **Data** al CSV, che prima non
c'era: con partite su più giorni non si capiva quale fosse quando.

**Verifiche ESEGUITE**: funzione lanciata con righe volutamente disordinate —
riordinate correttamente; CSV controllato con i nomi di colonna REALI del
database (`odd_x`, `odd_gg`, `odd_o25` in minuscolo, mappati da `rowToOdds`).
Un primo giro con nomi maiuscoli mostrava le colonne X/GG/Over vuote: era un
difetto del dato di prova, non del codice, ed è stato verificato invece che dato
per scontato.

### 2026-09-15 — Nota scenario: da posizione relativa a paletti assoluti

La nota 1X2 classificava per **forma**: Equilibrio se la X era la più alta
delle tre, altrimenti Progressione/Gap secondo l'ordine favorita < X <
sfavorita. Rossi ha chiesto paletti assoluti, e aveva ragione: una partita con
1=2,62 X=3,27 2=3,91 finiva in "Progressione" pur non avendo nessuna favorita
vera.

**Verifica prima di toccare** (chiesta da Rossi): confronto fra la regola nel
codice e quella descritta, su ~700 combinazioni di quote calibrate su valori
reali. Coincidevano nel 68%. Tutta la divergenza era una sola famiglia: partite
senza favorita sotto 2,00 che il codice chiamava Progressione per via
dell'ordine.

La descrizione a voce aveva però due difetti, segnalati e poi risolti insieme:
- **sovrapposizione**: 1=4,93 X=4,08 2=2,02 rientrava sia in Equilibrio
  (entrambe sopra 2, X sopra 2,99) sia in Gap (X sopra 4);
- **buco**: una quota di esattamente 2,00 non era né "sotto 1,99" né "sopra 2",
  quindi non cadeva in nessuna categoria.

**Regola nuova, una sola discriminante — esiste una favorita sotto 2,00?**

- **no** → EQUILIBRIO, anche con 1 e 2 a 4. Se nessuno è favorito la partita è
  in equilibrio, punto.
- **sì** → conta dove sta la X: da **4,00 in su** → GAP TECNICO; **sotto 4,00**
  → PROGRESSIONE.

Niente buchi (ogni partita cade da qualche parte), niente sovrapposizioni.

**Due scelte prese da Claude e segnalate a Rossi**: l'equilibrio non controlla
la X (con entrambe sopra 2,00 e X sotto 2,99 — partita bloccata — resta
equilibrio, il caso più equilibrato che esista); e favorita sotto 2,00 con X
sotto 3,00 va in Progressione, combinazione che in pratica non si verifica ma
meglio coperta che scoperta.

**Verifiche ESEGUITE**: 12 casi limite compresi tutti gli esempi di Rossi e i
due difetti di cui sopra — tutti corrispondono; su un listino di quote reali la
classificazione si divide in tre fasce nette e graduali: favorita fino a ~1,65 →
Gap, da 1,72 a 1,99 → Progressione, da 2,00 in su → Equilibrio.

Resta un calcolo di sola lettura: non tocca verdetto, motore, IA o storico.

### 2026-09-14 (2) — PRINCIPALI ristretto, nazioni a selezione multipla, TypingMind

**PRINCIPALI.** Usava `isTop`, cioè "prima divisione di qualsiasi nazione": in
una giornata piena uscivano decine di campionati. Ora ha due comportamenti:

- **da solo** → elenco fisso deciso da Rossi (GER1, ING1, SPA1, ITA1, FRA1,
  OLA1, NOR1, POR1, USA1, SVE1, DAN1) **più tutte le competizioni europee**
  (EUCHL, EUEL, EUCONFL…), che non avendo una nazione non sarebbero
  raggiungibili in nessun altro modo;
- **insieme a una o più nazioni** → solo la prima divisione di quelle nazioni.
  "Italia + Germania + PRINCIPALI" dà ITA1 e GER1; senza PRINCIPALI dà anche
  ITA2, ITA3, GER2…

Aggiunta `isFirstDivision()` in `leagues.ts` perché `isTop` è troppo permissivo:
il suo `/^[A-Z]+1(?!\d)/` accetta anche `ITA1F` (femminile) e `BRA1RS`
(riserve). La nuova usa `/^[A-Z]{2,4}1$/`.

**Nazioni a selezione multipla.** Il filtro era a scelta singola
(`countryFilter: string | null`); ora è `countryFilters: string[]`, senza limite
di quante se ne possono attivare. Il pallino sul pulsante FILTRI conta ogni
nazione scelta.

**TypingMind al posto di Google AI Studio.** L'indirizzo era scritto a mano in
**tre file** (`book.tsx`, `selected.tsx`, `strumenti.tsx`): ora sta in
`src/utils/aiChat.ts`, così la prossima volta non se ne aggiornano due su tre.

Il prompt NON viaggia nell'indirizzo: TypingMind tiene le conversazioni nel
browser e non ha un parametro documentato per precompilare il testo. Resta il
meccanismo che già funzionava — testo negli appunti, scheda aperta, incolla —
che ha il vantaggio di non dipendere da come quel sito legge gli indirizzi.

**Il prompt ora contiene l'istruzione, non solo i dati.** Prima arrivava un CSV
di quote e basta, e la richiesta andava scritta a mano ogni volta. Ora
`aistudio-prompt` antepone la consegna: ricerca sulle partite, pronostico, e una
multipla con quota totale di almeno 13, con motivazione per riga e quota finale.

**Verifiche**: `isMainLeague` e `isFirstDivision` ESEGUITE sui casi limite
(ITA1/ITA2/BEL1/ITA1F/BRA1RS/EUCHL/SCO1); `aistudio-prompt` eseguita con dati
finti, controllato il testo completo che finisce negli appunti; `tsc` a 18
errori di baseline, nessuno nuovo; `expo export` completato.

### 2026-09-14 — Upload Excel rotto su Vercel: `Dynamic require of "stream"`

Rossi segnala che il caricamento del file Excel non funziona più. **Non ha
toccato niente lui**: è una vittima della migrazione, emersa solo ora perché
l'upload non era fra le cose provate subito dopo il passaggio.

**Diagnosi dai log di esecuzione Vercel**, non per ipotesi:

```
POST /upload-excel 500
Error: Dynamic require of "stream" is not supported
  at netlify/functions/upload-excel.mjs:11
  at make_xlsx_lib (…:33241)
```

`upload-excel.mjs` è un bundle generato da esbuild con xlsx dentro. xlsx è
CommonJS e chiama `require("stream")` mentre si inizializza, ma il bundle è un
modulo ESM dove `require` non esiste: esbuild ci mette uno shim che, non
trovandolo, **lancia**. La funzione moriva al caricamento del modulo, prima
ancora di leggere il file caricato.

**Perché su Netlify non si vedeva**: il bundler di Netlify ricompilava il file
prima di eseguirlo e forniva un `require` vero. Vercel lo esegue com'è.

**Correzione**: due righe in testa al bundle che ricostruiscono un `require`
funzionante da `createRequire(import.meta.url)`. Devono stare PRIMA dello shim,
così quando lui controlla `typeof require !== "undefined"` trova quello vero.
Nessuna ricompilazione, nessun cambio alla logica di parsing.

**LEZIONE**: un artefatto pre-compilato committato nel repo (come questo
bundle) porta con sé assunzioni sull'ambiente che lo eseguirà. Cambiando
piattaforma, quelle assunzioni vanno riverificate una per una — un bundle non è
codice portabile solo perché è JavaScript.

**Verifiche fatte ESEGUENDO, non compilando**: modulo importato in Node (prima
lanciava all'import, ora carica); POST senza file → 400 controllato; POST con un
vero `.xlsx` generato al momento → **200**, con xlsx che ha aperto e letto il
foglio. `rows_seen: 0` perché il file di prova non ha il formato Sisal, ma il
parsing è arrivato in fondo senza errori.

### 2026-09-11 (5) — 504 su ai-predict: due numeri che dovevano accordarsi e non lo facevano

Rossi lancia un pronostico con Nemotron 3 Ultra e riceve un **504 Gateway
Timeout**, cioè un errore muto della piattaforma invece del nostro messaggio.

**Causa**: `maxDuration` a 60s in `vercel.json` e taglio dell'AbortController a
55s dentro `callLlm`. Cinque secondi di margine — ma fra l'inizio della function
e la fine ci sono **10 chiamate a Supabase** (statistiche famiglie, scenario,
soglia, poi la scrittura del pronostico e gli incrementi di spesa). La function
veniva uccisa dalla piattaforma prima che il nostro errore leggibile potesse
uscire.

**Correzione strutturale, non un numero aggiustato a mano.** Il taglio ora si
**deriva** dal tetto della piattaforma meno una riserva esplicita per tutto ciò
che non è la chiamata al modello: 300s − 45s = 255s su Vercel, 26s − 5s = 21s
su Netlify. Restano due costanti da tenere in accordo (`maxDuration` in
`vercel.json` e `platformCapMs` qui), ed è scritto nel commento.

`maxDuration` alzato da 60 a **300s**, il massimo documentato del piano Hobby.

**MA — Nemotron 3 Ultra resta non utilizzabile per questo prompt, e non è un
problema di timeout.** La scheda del modello dichiara ~6 token al secondo. Il
nostro prompt chiede un JSON sui 54 mercati, con tetto a 3000 token di uscita:
3000 ÷ 6 ≈ **500 secondi**, oltre il massimo assoluto del piano. Nessun tetto
raggiungibile basta. Il messaggio d'errore ora indirizza esplicitamente a
**Nemotron 3 Super**, che è lo stesso modello in versione più piccola.

**LEZIONE**: quando due limiti devono stare in accordo (il tetto della
piattaforma e il nostro taglio), il secondo va CALCOLATO dal primo. Scritti a
mano separatamente, prima o poi divergono — e qui la divergenza si manifestava
come un errore muto, il tipo peggiore da diagnosticare.

**Verifiche**: budget ESEGUITO con `fetch` finto — 21s senza `VERCEL`, 255s con.

### 2026-09-11 (4) — Le function giravano in Virginia, il database sta in Irlanda

Su Vercel l'app funzionava ma era lenta ad aprire le partite. Invece di
ipotizzare ho letto i log di esecuzione e risolto il dominio del database.

**CAUSA PRINCIPALE — regione sbagliata.** `db.zjucgmngettxfwgxazxl.supabase.co`
risolve a `2a05:d018:…`, che è AWS **eu-west-1 (Irlanda)**. Le Vercel Function
partono per default in `iad1` (Virginia). Ogni query attraversava l'Atlantico
due volte, ~160ms di sola andata e ritorno, e le nostre function ne fanno
parecchie **in sequenza**: `match-history` da sola fa storico globale, storico
per campionato e due RPC di forma squadre. Aggiunto `"regions": ["dub1"]` in
`vercel.json`: Dublino è la stessa regione AWS del database, quindi le query
passano da ~160ms a pochi millisecondi. Migliora anche il tratto
utente→function, visto che Rossi è a Roma.

Su Netlify il problema c'era identico (function in `us-east-1`), solo che non
avevamo mai guardato.

**Chiamate duplicate all'avvio.** Nei log si vedevano tre `/matches-days` e tre
`/ml-stats` in quattro secondi. Causa: `load(null)` all'avvio scarica giorni e
statistiche, poi imposta il giorno più vicino, il che fa ripartire `load(day)`
che le riscarica entrambe. Ora `load(day)` riusa le cache se sono fresche.

**Precaricamento della partita successiva.** Mentre si legge una partita la
connessione è ferma: dopo 1,2 secondi (per non rubare banda al caricamento in
corso) parte in sottofondo il pacchetto della prossima in Schedina. Premendo
AVANTI compare istantanea invece di ricominciare da cinque richieste. Se AVANTI
non viene premuto si è sprecata una richiesta — costo accettabile, in una
schedina si scorre quasi sempre in avanti.

**LEZIONE**: prima di ottimizzare il codice, controllare **dove girano le cose**.
Nessuna quantità di cache avrebbe compensato un oceano di troppo a ogni query.

### 2026-09-11 (3) — Vercel: 27 function erano troppe, ora ce n'è una sola

Primo deploy su Vercel fallito. Sintomo ingannevole: **il build passava**
(esportazione Expo completata, 27 function compilate) e l'errore arrivava subito
dopo, al passo "Deploying outputs", **senza niente nei log del build**.

Causa: il piano Hobby di Vercel accetta al massimo **12 Serverless Function per
deploy**. Noi ne creavamo 27, una per involucro. Il controllo avviene alla
consegna, non alla compilazione, ed è per questo che i log del build erano
puliti.

**Soluzione**: un solo `api/[route].ts` che riceve tutte le rotte e smista al
gestore giusto in base all'ultimo segmento del percorso, con import statici (il
bundler deve poterli seguire a tempo di compilazione, quindi niente import
dinamici). `upload-excel.mjs` resta separato perché è già un bundle con xlsx
dentro ed è JavaScript, non TypeScript: importarlo dal dispatcher creerebbe
problemi di risoluzione senza vantaggi. **Totale: 2 function contro un tetto
di 12**, con margine per crescere.

Il dispatcher ricava il nome dall'ultimo segmento, quindi funziona sia con la
rotta pulita `/predict` (riscritta da `vercel.json`) sia con `/api/predict`
diretta: non dipendiamo da come Vercel presenta l'URL dopo un rewrite.

`netlify/functions/` non è stato toccato. Le implementazioni restano uniche.

**LEZIONE**: su Vercel Hobby, un build verde non significa deploy riuscito. I
limiti di piano si applicano alla consegna e non lasciano traccia nei log del
build — vanno letti dalla pagina del deploy.

**Verifiche**: dispatcher compilato con esbuild (tutti e 26 gli import risolti)
ed ESEGUITO davvero: rotta inesistente → 404 con messaggio leggibile,
`/llm-settings` e `/api/llm-settings` → entrambe 200 sullo stesso gestore.

### 2026-09-11 (2) — Migrazione a Vercel: il repo ora sa girare su due piattaforme

Netlify si era bloccato per una **fattura non pagata** da $9 (i crediti di build
NON erano esauriti: 914 su 1.000 ancora disponibili). Rossi ha deciso di passare
a Vercel. Motivo che resta valido a prescindere dal blocco: su Netlify le
function si fermano a 26 secondi, ed è quel tetto che impedisce di usare i
modelli lenti come Nemotron.

**Scelta di fondo: nessuna duplicazione della logica.** Le 27 function restano
dove sono, in `netlify/functions/`. In `api/` ci sono 27 **involucri sottili**
che le richiamano. Le due piattaforme dichiarano le funzioni in modo diverso —
Netlify vuole un `export default` che riceve una `Request`, Vercel vuole un
export per ogni metodo HTTP — ma il corpo è identico, perché entrambe usano
`Request` e `Response` standard del web. Così durante la migrazione l'app
funziona su tutte e due e non c'è codice da mantenere in doppio.

**Le rotte pubbliche non cambiano.** Il frontend chiama percorsi puliti
(`/predict`, `/matches-list`, …) e i 27 rewrite in `vercel.json` li mappano su
`/api/*` esattamente come facevano i redirect di `netlify.toml`. **Zero
modifiche al frontend**, che è la parte che riduce di più il rischio.

**`maxDuration` a 60s** in `vercel.json`, contro i 26 non negoziabili di
Netlify. Si può salire fino a 300 sul piano Hobby, ma prima va verificato sul
campo.

**Timeout LLM ora adattivo.** Era fisso a 22s, tarato sul tetto di Netlify. Ora
legge la variabile `VERCEL` (che Vercel imposta da sola) e usa 55s quando gira
lì. Durante la migrazione lo stesso codice gira su entrambe, quindi il valore
va scelto a tempo di esecuzione e non scritto fisso.

**`package.json` nella root** solo per dichiarare Node 22 a Vercel, la stessa
versione che `netlify.toml` dichiara a Netlify.

`netlify.toml` **non è stato toccato**: Netlify continua a funzionare come
prima. Si spegne solo quando Vercel è verificato.

**Verifiche fatte**: tutti e 27 gli involucri compilati e risolti davvero con
esbuild (non solo controllati a vista); rotte di `netlify.toml` confrontate una
a una con le funzioni esistenti — 27 rotte, 27 funzioni, nessuna orfana da
nessuna delle due parti; timeout adattivo ESEGUITO con `fetch` finto e
verificato a 22s senza `VERCEL` e 55s con `VERCEL`; firma delle funzioni Vercel
verificata sulla documentazione ufficiale invece che a memoria.

### 2026-09-11 — [skip ci] ha bloccato il deploy di OpenRouter + Nemotron Super

Rossi non vedeva Nemotron nel menu modelli. Causa: il commit `db48557` era
stato pushato con `[skip ci]` in fondo al messaggio — Netlify lo ha
correttamente ignorato e non ha costruito niente. Il tentativo di rimedio
(`221c246`, commit VUOTA) non ha risolto: senza file modificati non parte
nessun build. Il deploy pubblicato era rimasto a `fcc5d239`, verificato col
`commit_ref` del published deploy.

**REGOLA, da rispettare d'ora in avanti**: `[skip ci]` va SOLO su modifiche che
non devono andare online (CHANGELOG, commenti, refactoring interno). Una
funzionalità che l'utente deve poter usare non lo porta mai. E se serve
innescare un build, la commit deve contenere una modifica vera: una commit
vuota non basta.

Aggiunto nel frattempo **Nemotron 3 Super** (`nvidia/nemotron-3-super-120b-a12b:free`)
come alternativa più veloce di Ultra, da usare se Ultra va in timeout a 22s.

### 2026-09-10 (5) — OpenRouter come provider, Nemotron 3 Ultra nel menu modelli

Richiesta di Rossi: aggiungere `NVIDIA: Nemotron 3 Ultra (free)` accanto a
DeepSeek e Groq nella scelta del modello.

Costo basso perché OpenRouter parla il formato OpenAI come gli altri due:
stesso `/chat/completions`, stesso body. È bastato aggiungere base URL, nome
della variabile d'ambiente (`OPENROUTER_API_KEY`) e una voce in `LLM_OPTIONS` —
il menu del frontend è generato da quell'elenco, quindi compare da solo.

Modello: `nvidia/nemotron-3-ultra-550b-a55b:free`, endpoint
`https://openrouter.ai/api/v1`.

**Adattamenti specifici, tutti dovuti al fatto che i modelli `:free` sono lenti
e contingentati:**

- `max_tokens` a 3000 su OpenRouter invece di 8000. Nemotron è un modello di
  ragionamento, ma con 8000 token di uscita a quella velocità la funzione muore
  prima della fine: meglio una risposta corta che arriva.
- **Timeout esplicito a 22s** con `AbortController`. Netlify uccide le function
  intorno ai 26 secondi senza spiegazioni: tagliando prima, l'errore che arriva
  a schermo dice cosa è successo invece di un 502 muto.
- **429 riconosciuto e spiegato**: i `:free` sono a 20 richieste/minuto e 50 al
  giorno (1.000 dopo un acquisto una tantum da $10). Ci si arriva in fretta, e
  un messaggio generico avrebbe fatto perdere tempo.
- **Errore dentro una risposta 200**: OpenRouter a volte risponde 200 con un
  `error` nel corpo (tipicamente "no endpoints available"). Ora viene
  intercettato invece di produrre un JSON vuoto.
- **Ragionamento**: OpenRouter espone il campo `reasoning`, DeepSeek
  `reasoning_content`. Si provano entrambi prima di arrendersi.
- Header `HTTP-Referer` e `X-Title` aggiunti solo per OpenRouter.

**`isProviderUsable()`** sostituisce `CONFIGURED_PROVIDERS.has()` in
`llm-settings`: prima bastava essere nell'elenco per risultare "configurato",
anche senza chiave. Ora si controlla che la variabile d'ambiente esista davvero,
quindi il modello appare spento finché la chiave non è su Netlify.

**Verifiche**: adapter ESEGUITO davvero con `fetch` finto su sei casi — risposta
normale, fallback su `reasoning`, 429, errore dentro una 200, timeout (scattato a
22s come previsto), e DeepSeek invariato (nessun header OpenRouter, `thinking`
ancora disabilitato). `tsc` pulito sulle function e a 18 errori di baseline sul
frontend.

**NOTA**: `OPENROUTER_API_KEY` va aggiunta su Netlify da Rossi — gli strumenti
disponibili a Claude non permettono di leggere né scrivere le variabili
d'ambiente.

### 2026-09-10 (4) — Pulizia della zona bassa: via la freccia flottante, spazi riallineati

Da uno screenshot di Rossi con la barra AVANTI finalmente al suo posto, ma la
zona in fondo disordinata.

**Via `FabBack`.** La freccia circolare flottante in basso a destra duplicava il
tasto indietro che ogni schermata non-hub ha già in alto a sinistra, e da quando
c'è la barra ESCI/PREC/AVANTI ci finiva letteralmente sopra. Rimossa da
`_layout.tsx`; il componente resta in `src/components/` se servisse di nuovo.

**Misure della BottomNav esportate (`useNavMetrics`).** Erano ricopiate a mano in
`match/[id].tsx` con numeri leggermente diversi (`insets.bottom + 56 + 12`
contro `Math.max(insets.bottom, 24) + 12 + 56`), e fra le due barre restava una
striscia di sfondo. Ora il numero è uno solo e viene dalla stessa funzione.

**Fascia vuota sotto le etichette.** `Math.max(insets.bottom, 24) + 12` lasciava
sotto PRONOSTICO AI / RISULTATO / QUOTE un vuoto grande quanto le etichette
stesse: `insets.bottom` tiene già conto della barra di sistema, quindi il minimo
forzato serve solo da rete di sicurezza. Sceso a `Math.max(insets.bottom, 8) + 6`,
con `paddingTop` 8 → 6 e gap icona/etichetta 4 → 3.

**Tasti tutti della stessa misura.** Prima ognuno si dimensionava sul proprio
contenuto e in fila risultavano di altezze e raggi diversi. Ora altezza fissa 38,
raggio 10, spazi regolari. PREC diventa quadrato senza etichetta — è il gesto
meno frequente, e così resta larghezza per AVANTI, che è quello che si usa.
Sfondo della barra identico a quello della BottomNav, così le due si leggono
come un blocco unico.

**Spazio in fondo alla ScrollView** non più un `paddingBottom: 200` buttato lì
ma `navHeight + 64`, calcolato: niente contenuto coperto e niente vuoto di
troppo.

**Verifiche**: `tsc --noEmit` a 18 errori come la baseline; `expo export`
completato.

### 2026-09-10 (3) — La barra di scorrimento spostata in fondo, aggiunto ESCI

Rossi non trovava il tasto AVANTI: era stato messo sotto l'header, in cima,
mentre lui lo cercava in fondo. Spostato in una barra fissa sopra la BottomNav
— dove arriva il pollice, e dove sta già "Salva → Prossima" nella schermata
risultato: stesso gesto, stesso posto.

La barra ora è **sempre presente** in `/match/[id]`, non solo quando la partita
è in Schedina, così c'è sempre una via d'uscita esplicita:

- **ESCI** sempre a sinistra (torna indietro, o alla home se non c'è storia);
- **PREC · n/tot · AVANTI** solo quando la partita è in Schedina e ce n'è più
  di una;
- altrimenti al loro posto una riga che dice perché non ci sono ("Partita non
  in Schedina" / "Unica partita in Schedina"), invece del nulla di prima.

Quel testo serve anche a diagnosticare: se un domani i tasti non compaiono, la
riga dice se il problema è la selezione o il caricamento della lista.

**Verifiche**: `tsc --noEmit` a 18 errori come la baseline; `expo export`
completato e stringa "AVANTI" confermata dentro il bundle esportato.

### 2026-09-10 (2) — Tasto AVANTI in Schedina, barra in basso di nuovo fissa

Due correzioni chieste da Rossi dopo aver provato la sessione precedente.

**1) Scorrimento fra le partite della Schedina.** Aprendo una partita
selezionata si restava bloccati lì: per vedere la successiva bisognava tornare
indietro alla Schedina e riaprirla a mano. Aggiunta sotto l'header di
`/match/[id]` una barra **PREC · n/tot · AVANTI**, visibile solo quando la
partita è in Schedina e ce n'è più di una. La lista arriva da
`selectedListCache`, la stessa già usata da Schedina e schermata risultato,
quindi nel caso normale non costa nessuna richiesta. La navigazione usa
`router.replace` e non `push`: scorrendo dieci partite non deve accumularsi una
pila di dieci schermate da smontare col tasto indietro.

**2) Auto-hide della BottomNav disattivato.** Nell'intervento precedente
l'header a scomparsa era stato agganciato alla stessa `SharedValue` che già
nascondeva la barra in basso, e così scorrendo sparivano anche Profilo,
Strumenti, Partite, Schedina e Book. Errore di valutazione: quella barra
contiene i **comandi di navigazione**, e nasconderli obbliga a risalire in cima
per cambiare schermata. L'header e la striscia dei giorni, invece, sono
informazione — nasconderli guadagna spazio senza togliere niente.

**REGOLA GENERALE che ne esce**: si può nascondere allo scroll ciò che si
*legge*, mai ciò con cui si *comanda*.

`visible` resta viva e continua a comandare l'header nella home. In
`BottomNav.tsx` è rimasto un commento che spiega come riattivare l'auto-hide se
mai servisse.

**Verifiche**: `tsc --noEmit` a 18 errori come la baseline, nessuno nuovo;
`expo export --platform web` completato.

### 2026-09-10 — Velocità di navigazione, ricerca/filtri, header a scomparsa

Sessione partita da una lista di attriti segnalati da Rossi. Cinque interventi.

**A) `match-result.ts` era rimasto sulla vecchia logica di apprendimento — bug,
non solo lentezza.** Il 28/07 la logica è stata estratta in
`lib/applyResult.ts` con la protezione contro il doppio conteggio e
l'apprendimento per scenario, ma è stata collegata solo a `results-apply`,
`results-bulk` e `results-fetch`. L'endpoint del pulsante **Salva** nella
schermata risultato — quello usato di più — è rimasto sulla copia vecchia.
Conseguenze: salvando da lì `scenario_market_scores` e `system_scorecard`
**non venivano mai aggiornate** (apprendimento incrementale spento sulla via
principale), e non c'era il controllo sul risultato precedente, quindi
risalvare contava due volte e correggere lasciava i conteggi vecchi — lo stesso
bug di Mariehamn-Ac Oulu che credevamo chiuso. Ora `match-result.ts` delega a
`applyMatchResult()`. Effetto collaterale gradito: la vecchia versione
aggiornava i contatori un mercato alla volta (~110 richieste in sequenza a
Supabase), `applyMatchResult` usa una sola RPC `apply_family_result`.

**LEZIONE**: quando si estrae della logica "per non rischiare di rompere il
file già in produzione", va aperto subito un punto per collegarcelo. Qui il
commento nel codice diceva esattamente questo, ed è rimasto lì sei settimane.

**B) Apertura partita: da 6-11 richieste a 0 (se in cache).** Aprire una
partita lanciava `match-detail`, `ml-stats` (500 righe), `match-candidates`,
`predict` (motore sui 54 mercati), `match-history` e `odd-settings`, nessuna
in cache. Peggio: `load` dipende da `minOdd`, che arrivava da `odd-settings`
in modo asincrono, quindi con una soglia salvata diversa da 1,40 **tutte e
cinque le chiamate ripartivano da capo**. Ora:

- `matchDetailCache` in `utils/cache.ts` tiene il pacchetto completo per
  (partita, soglia), stale-while-revalidate a 5 minuti come già fa la home;
- la soglia si legge **una volta per sessione** (`oddSettingsCache` +
  promessa condivisa), e il caricamento aspetta di conoscerla: niente più
  doppio giro;
- `ml-stats` legge `marketStatsCache`, che il file importava solo per
  invalidarla.

**C) Schedina e schermata risultato.** `selected.tsx` faceva `setLoading(true)`
e una fetch bloccante a ogni ingresso ignorando `selectedListCache`: ora
stale-while-revalidate. `risultato/[id].tsx` riscaricava la lista dei
selezionati a ogni partita della sequenza "salva e scorri" solo per sapere
quale fosse la prossima: ora la legge dalla cache e, dopo il salvataggio, la
**aggiorna sul posto** invece di invalidarla (invalidarla avrebbe rimesso la
richiesta esattamente dove la stavamo togliendo). Animazione dello Stack da
220 a 160 ms.

**D) Ricerca e filtri.** La ricerca confrontava solo `squadra1 + squadra2 +
manifestazione`, e `manifestazione` contiene il **codice** (`ITA1`), non il
nome: cercare "Italia" o "Francia" non poteva trovare nulla. Ora entrano nel
confronto anche il nome leggibile, la nazione e l'area. La barra di ricerca
era un cerchio da 40px che apriva un campo stretto: ora è a tutta larghezza,
sempre visibile, testo 16px. La modale filtri era un riquadro centrato
all'85%: ora è a tutto schermo, con azzera + conteggio partite in fondo, e una
terza sezione **COMPETIZIONE** che prima non esisteva (le coppe europee, che
non hanno una nazione, non erano raggiungibili da nessun filtro).

**E) Codici UEFA mancanti.** Era mappato solo `EUCONFL`: `/^CHAM/` non cattura
`EUCHL` e `/^EUR(?!O)/` non cattura `EUEL`, quindi finivano in area "Mondo"
col codice grezzo al posto del nome. Aggiunti `EUCHL`, `EUEL`, `EUNL`, `EUSC`,
`EURO`, più una rete di sicurezza `/^EU/` → "Competizione europea" per i codici
che ancora non conosciamo. Allineate le due copie della mappa:
`frontend/src/utils/leagues.ts` e `netlify/functions/lib/leagueContext.ts`
(quest'ultima alimenta il prompt dell'IA). `backend/server.py` è morto, ignorato.

**F) Header a scomparsa.** Header e striscia dei giorni collassano scrollando
verso il basso e ricompaiono scrollando verso l'alto, riusando la stessa
`SharedValue` di reanimated che già comanda la BottomNav (soglia 12px, già
agganciata all'`onScroll` della lista). Il collasso usa un `marginTop` negativo
pari all'altezza misurata con `onLayout`, così lo spazio viene restituito
davvero alla lista invece di lasciare un buco come farebbe un `translateY`.

**Verifiche fatte**: `parseLeagueCode` eseguita davvero sui codici nuovi e su
quelli vecchi (nessuna regressione su ITA1/FRA1/AMINAZ/CPLIB/BRA1RS);
`tsc --noEmit` confrontato con la baseline — 18 errori preesistenti prima, 18
dopo, nessuno nuovo; `expo export --platform web` completato senza errori.

### 2026-07-28 — Salvataggio risultato: da ~110 chiamate a 1

L'unica parte davvero pesante rimasta su Netlify. Per ogni risultato salvato,
`applyMatchResult` faceva in sequenza:

- 2 chiamate per i contatori di famiglia (globale + campionato)
- 2 per ogni mercato proposto dall'IA
- 2 per ognuno dei 54 mercati standard, per le "occasioni mancate"

Fino a **~110 richieste HTTP** dalla function a Supabase, una dopo l'altra,
ognuna con la sua latenza. E' li' che se ne andava il tempo di esecuzione — cioe'
i crediti di calcolo — ed era anche il motivo per cui salvare molti risultati
dalla Schedina rischiava il timeout.

Nuova funzione SQL `apply_family_result(famiglia, campionato, proposti, casa,
ospite)`: il ciclo gira dentro il database, dove i dati gia' sono. **Nessuna
logica riscritta** — richiama le stesse `increment_market_score`,
`increment_missed_win` e `increment_family_counter` di prima, solo senza
attraversare la rete cinquanta volte. Niente terza copia della logica.

Verificata con una prova a vuoto su una famiglia finta, poi ripulita: 50 mercati
valutati, mercato proposto e vincente registrato 1W/0L, mercato non proposto ma
vincente registrato come occasione mancata. Comportamento identico a prima.

Con questa, il percorso "inserisci risultato" fa **3 chiamate al database** in
tutto: la pagella dei tre sistemi, lo storico per scenario, e questa.


### 2026-07-28 — HOTFIX: senza giocata spariva anche il selettore della quota

Regressione introdotta con l'astensione. Quando nessun mercato coerente superava
la soglia, `buildFinalVerdict` restituiva una lista vuota e la schermata usciva
con `return null`: spariva **l'intero riquadro del verdetto**, selettore della
quota minima compreso. L'utente restava davanti a una pagina muta, **senza il
comando per abbassare la soglia** e sbloccarsi — un vicolo cieco.

Ora il riquadro c'e' sempre. Quando non c'e' una giocata mostra il selettore e
la spiegazione: *"Nessuna giocata a quota X — sopra questa soglia non resta
nessun mercato coerente con la lettura della partita. Abbassa la quota minima
qui sopra."*

*Lezione*: ogni volta che si introduce un caso "niente da mostrare", va
verificato che i **comandi** per uscirne restino a schermo. L'astensione e' una
risposta, non l'assenza di interfaccia.


### 2026-07-28 — Mercati opposti: il confronto vale con TUTTI quelli piu' in alto

Segnalato da Rossi su Deportivo Riestra - Boca (finita 3-0): a soglia 1,40 il
pick era `NG` @1,48, a 1,50 diventava `GG` @2,50. Due mercati opposti, esattamente
cio' che avevamo vietato.

**Causa.** Il controllo confrontava il candidato solo con la **direzione** (il
mercato ammesso piu' probabile). Li' la direzione era `DC X2 + U3.5`, e sia `NG`
sia `GG` risultavano compatibili con essa: nessuno dei due veniva bloccato,
quindi alzando la soglia si passava dall'uno all'altro.

**Correzione.** Un mercato e' valido solo se non contraddice **nessuno** di
quelli piu' in alto in classifica, non solo la direzione. Se un mercato piu'
probabile dice il contrario, quello sotto non si gioca. Con `NG` al 57% sopra,
`GG` al 43% e' ora escluso a qualsiasi soglia.

Verificato eseguendo motore e fusione sulle quote reali prese dal database:
1,40 e 1,50 → `MG 2-4 totali` @1,50 · 1,60 → `NG` @1,60 · 1,75 → **nessuna
giocata** (niente di coerente sopra soglia, ed e' il comportamento voluto).

### 2026-07-28 — Rimosso l'ignore command da netlify.toml

Sospettato numero uno dei "deploy fantasma": build registrate col commit nuovo
ma che ripubblicano i file vecchi. Rossi ha visto piu' volte il sito servire
codice che non corrisponde al repository, anche dopo un "clear cache and deploy"
e in finestra anonima. Risparmiare qualche credito non vale il rischio di
pubblicare codice fantasma: il risparmio resta affidato a `[skip ci]` nei
messaggi di commit, che e' esplicito e verificabile.

*Nota diagnostica*: `frontend/dist` NON e' tracciata da git (e' in `.gitignore`),
quindi il bundle pubblicato lo costruisce sempre Netlify. Le build locali servono
solo a verificare che il codice compili, non finiscono online.


### 2026-07-27 — Un mercato senza quota veniva saltato in silenzio

Su Zaglebie - Piast il verdetto usciva `O2.5` @2,10 al **45%** mentre
`MG 2-4 totali` al **60%** stava molto piu' in alto fra i mercati leggibili.
Il motore lo sceglieva correttamente; la fusione no.

**Causa.** Nella fusione i mercati ammessi venivano inseriti fra i candidati
con `odd: r.odd ?? undefined`. Se la voce del ranking arrivava senza quota, il
bucket restava senza prezzo, il filtro di soglia lo scartava
(`(b.odd ?? 0) >= minOdd` e' falso con quota assente) e il verdetto scivolava
piu' in basso — fino a un mercato al 45%.

**Correzione.** La quota si risolve subito, con tutte le strade disponibili in
ordine: voce del ranking → mappa completa `market_odds` (che copre tutti i 54)
→ quote grezze della partita. Cosi' un mercato non puo' piu' sparire dalla
selezione per un prezzo mancante.

Verificato eseguendo la fusione con la voce del ranking priva di quota: a 1,40
e 1,50 esce `MG 2-4 totali` @1,56, come nel motore.


### 2026-07-27 — Probabilita' onesta a schermo e astensione per famiglia

**1. La probabilita' mostrata e' quella corretta dallo storico.** Il motore
ordinava gia' usando la correzione per scenario, ma a schermo scriveva il
numero grezzo di Poisson: si leggeva 65% su un mercato che il sistema stava
gia' trattando come meno affidabile. Ora `coverage` e `fragility` mostrano il
valore corretto; il grezzo resta disponibile in `coverage_poisson`.

**2. Se una famiglia non ha una lettura, si salta tutta.** Quando i due mercati
**opposti** piu' alti di una famiglia distano 5 punti o meno, il modello non sa
da che parte sta la partita: non e' una lettura, e' un pareggio. Quella famiglia
viene esclusa e si scende dove il motore ha davvero qualcosa da dire. Vale per
tutte e tre: esito (`1`/`2`/`1X`/`X2`), gol (`GG`/`NG`), totali
(`O2.5`/multigol). Se nessuna famiglia e' leggibile, nessuna giocata.

Verificato eseguendo motore e fusione su Zaglebie Lubin - Piast Gliwice
(finita 2-0), dove il ranking dava `X2` 65% e `1X` 62% — tre punti fra due
scenari opposti, e anche `GG` 51% contro `NG` 49%:

| Soglia | Prima | Dopo | Esito |
|---|---|---|---|
| 1,40 / 1,50 | `X2` @1,40 | **`MG 2-4 totali` @1,56** | perso → **vinto** |
| 1,60 / 1,75 | — | `O2.5` @2,10 | perso |

Due famiglie su tre erano illeggibili; la terza aveva qualcosa da dire, ed era
quella giusta.


### 2026-07-27 — Il tasto indietro torna al dettaglio della partita

Dalle schermate "inserisci risultato" e "quote", indietro riportava all'elenco
partite invece che alla partita che si stava guardando.

Causa: salvando un risultato la schermata avanza alla partita successiva con
`router.replace`, che **sostituisce** la voce nella cronologia invece di
aggiungerla. Da li' in poi `router.back()` riportava al punto da cui era
iniziata la catena — di solito l'elenco — e non al dettaglio.

Ora indietro va esplicitamente a `/match/{id}`: si torna sempre alla partita
che si stava guardando, qualunque strada si sia fatta per arrivarci.


### 2026-07-27 — La fusione riordinava il ranking invece di scorrerlo

Segnalato da Rossi su Atletico Ottawa - Pacific: il pick era `O2.5` @1,52
(59%, settimo nel ranking) mentre `1` @1,57 (63%) stava **quarto**, con
probabilita' e quota migliori.

**Causa.** La fusione riordinava i candidati con criteri propri —
probabilita', poi spareggio "entro 5 punti vince la quota piu' bassa". Con
63% contro 59% il divario stava dentro la banda di spareggio, e la quota piu'
bassa faceva vincere `O2.5`. Cioe' scorrevamo una lista **diversa** da quella
mostrata a schermo, e la regola concordata ("si scorre il ranking dall'alto")
non era rispettata.

**Correzione.** L'ordine della fusione e' ora **esattamente** quello del
ranking strutturale. Lo spareggio sulla quota resta, ma e' stato spostato
dentro il motore e vale solo a probabilita' **davvero** pari (entro un punto):
e' il caso `GG`/`NG` entrambi al 50% ma prezzati 1,57 e 2,20 per cui era nato.

Verificato eseguendo la fusione: a 1,40 e 1,50 esce `1` @1,57, a 1,60
`MG 3-6 totali` @1,62. Ranking e verdetto raccontano la stessa storia.

**Aperto**: il tasto indietro dalla schermata risultati non torna al dettaglio
della partita ma salta all'elenco.


### 2026-07-27 — Regola di selezione semplificata: si scorre il ranking

Rossi l'ha formulata cosi', ed e' piu' semplice di quella che avevo scritto:
**si scorre il ranking strutturale dall'alto e si prende il primo dei 18
mercati ammessi che paga almeno la soglia scelta**, saltando quelli che
raccontano la partita al contrario.

Via la preferenza esplicita per le combo: se un mercato sta piu' in alto, ha
coverage migliore e quota sufficiente, e' lui — combo o no. Le combo vengono
scelte quando se lo meritano per posizione, non per una regola apposta.

Verificato eseguendo la fusione su New York RB - Crown Legacy (finita 0-3):

| Soglia | Pick | Esito |
|---|---|---|
| 1,40 | `MG 3-6 totali` @1,49 (61%) | vinto |
| 1,50 | `MG 2-4 totali` @1,55 (60%) | vinto |
| 1,60 | `GG + O2.5` @1,73 (55%) | perso |
| 1,75 | `1` @1,75 (55%) | perso |

Muovendo il selettore il pick ora cambia davvero, scendendo lungo il ranking.
`O2.5` (66%) e `GG` (64%) restano in cima ma pagano 1,30 e 1,33: sotto ogni
soglia, quindi saltati. `NG` resta escluso perche' contraddice la direzione.

**Annotato per il futuro** (osservazione di Rossi, non ancora implementata):
`MG 3-6 totali` sul book ufficiale paga tipicamente **dal 3% all'8% in piu'** di
`O2.5`. La nostra stima si puo' tarare su quel rapporto invece di partire solo
da Poisson.


### 2026-07-27 — La fusione vedeva meno mercati del motore

Segnalato da Rossi su Colo Colo - Deportes Limache (finita 3-1): a soglia 1,60
il verdetto era `NG` @2,20 al 48%, mentre nel ranking c'era gia'
`DC 1X + O2.5` @1,66 al 54% — piu' probabile, sopra soglia e coerente con la
lettura della partita (casa nettissima, λ 2,23 contro 0,89).

**Causa.** I candidati della fusione erano solo i primi N di ciascuno dei tre
sistemi. `DC 1X + O2.5` stava dodicesimo nel ranking strutturale e non entrava
mai fra i candidati: la regola "rafforza la direzione con una combo coerente"
non poteva applicarla perche' quella combo non le arrivava. Il motore la
sceglieva correttamente, la fusione no — due risposte diverse sulla stessa
partita.

**Correzione.** Tutti i 18 mercati ammessi entrano fra i candidati della
fusione, anche quelli che nessun sistema ha nominato nei suoi primi posti.

**Seconda segnalazione, stessa radice**: `DC 1X + GG` non compariva nel ranking.
Non era un errore di calcolo (45%, quota 2,09) ma il taglio ai primi 20: stava
ventunesimo. Ora il ranking mostra i primi 20 **piu'** tutti i mercati ammessi
al verdetto, ovunque si trovino.

**Verificato eseguendo davvero la fusione** su quelle quote:

| Soglia | Prima | Dopo |
|---|---|---|
| 1,40 / 1,50 | `1` @1,50 | `DC 1X + O2.5` @1,66 |
| 1,60 | `NG` @2,20 | `DC 1X + O2.5` @1,66 |
| 1,75 | — | `DC 1X + GG` @2,09 |

Sul 3-1 entrambe le combo vincono; `NG` avrebbe perso.


### 2026-07-27 — HOTFIX: schermata bianca aprendo una partita

`Uncaught ReferenceError: out is not defined` in `buildFinalVerdict`. Nel commit
precedente avevo rinominato `const out` in `const tutti` senza aggiornare le
dieci righe successive che ancora usavano `out`. La schermata di dettaglio
crashava e restava bianca.

**Perche' non l'ho intercettato**: `esbuild` compila senza lamentarsi, perche'
una variabile non definita e' JavaScript sintatticamente valido — esplode solo
a runtime. Il controllo che facevo (compila / non compila) non poteva vederlo.

**Da fare d'ora in poi su ogni modifica a `buildFinalVerdict`**: impacchettare
`api.ts` con esbuild ed ESEGUIRE davvero la funzione con dati finti a tutte e
quattro le soglie, non limitarsi a compilare. Comando che ho usato:

    npx esbuild frontend/src/api.ts --bundle --format=esm --platform=neutral \
      --outfile=/tmp/api.mjs --external:react --external:react-native \
      --external:expo* --external:@*
    node /tmp/smoke.mjs   # chiama buildFinalVerdict a 1.40 / 1.50 / 1.60 / 1.75


### 2026-07-27 — La soglia filtra la scelta, non l'analisi

Sei punti chiariti da Rossi, tutti implementati.

**1. Il ranking non cambia piu' con la soglia.** Prima i mercati sotto la quota
minima venivano scartati nella costruzione della classifica, quindi spostando
il selettore cambiavano posizioni, bonus e pick. Ma la lettura della partita non
cambia perche' l'utente vuole una quota piu' alta. Ora il ranking e' sempre lo
stesso; la soglia entra solo nella selezione finale.

**2. I mercati opposti non si sostituiscono mai.** Coppie riconosciute:
`1`↔`2`, `1`↔`X2`, `2`↔`1X`, `1X`↔`X2`, `GG`↔`NG`, `O2.5`↔`U2.5`,
`O1.5`↔`U1.5`, `O2.5`↔`NG`. Il confronto vale anche dentro le combo: con
direzione `1X`, `DC X2 + GG` e' escluso. Alzare la soglia non puo' piu'
ribaltare la lettura della partita.

**3. Un pick sotto soglia si recupera RAFFORZANDOLO, non capovolgendolo.**
Se `1X` e' il piu' probabile ma paga 1,35, si cercano `DC 1X + O1.5`,
`DC 1X + O2.5`, `DC 1X + GG`, `DC 1X + U3.5`: aggiungere una condizione alza la
quota senza cambiare direzione. Solo se nessuna combo basta si scende nel
ranking, sempre saltando cio' che contraddice la direzione.

**4. Astensione.** Se non resta nulla di coerente sopra soglia, valore nullo e
nessuna giocata. Meglio non proporre niente che proporre contro la propria
analisi.

**5.** I 18 mercati restano gli unici candidati al verdetto. Gli altri si
vedono nel ranking con COV, FRAG e punteggio, ma non entrano mai nella scelta.

**6. Card e dettaglio allineati.** La card nell'elenco partite ricalcolava un
pick per conto suo con una logica diversa da `buildFinalVerdict`: su
Sandnes - Kongsvinger diceva `DC X2 + O1.5` mentre il dettaglio diceva
`GG + O2.5`. Ora legge `pick_finale`, il verdetto salvato — stessa partita,
stesso pronostico ovunque, Schedina compresa.

Verificato su Sandnes - Kongsvinger: ranking identico a 1,40 e a 1,75, e il
pick passa da `GG + O2.5` @1,59 a `DC X2 + GG` @1,85 alzando la soglia — due
mercati coerenti fra loro, nessun ribaltamento.


### 2026-07-27 — Whitelist definitiva (18 mercati) e spareggio affidato al book

**Lista finale del verdetto**, decisa da Rossi:
`1`, `2`, `1X`, `X2`, `GG`, `NG`, `O2.5`, `MG 2-4 totali`, `MG 3-6 totali`,
`GG + O2.5`, e le combo `DC 1X/X2` con `O1.5`, `O2.5`, `U3.5`, `GG`.

Rispetto alla versione precedente rientrano `1`, `2`, `O2.5` (che erano fuori
pur essendo sempre piu' probabili delle combo `1 + O2.5` / `2 + O2.5`, ora
uscite) e i due multigol totali che il book prezza in fascia giocabile
(`2-4` intorno a 1,48-1,55 e `3-6` intorno a 1,50-1,78). Escono `O1.5` e `U3.5`
secchi. Tutti gli altri multigol — casa, ospite, combo di multigol — restano
**visibili nel ranking strutturale** ma non possono diventare la giocata.

**Spareggio: a parita' di probabilita' decide il bookmaker, non il nostro
punteggio.** Il caso che lo ha reso necessario: il modello dava `GG` e `NG`
entrambi al 50%, ma il book li prezzava 1,57 e 2,20. Con due nostre stime
uguali, la quota piu' bassa e' l'evento che il mercato ritiene piu' probabile —
e il mercato ha informazioni che noi non abbiamo (formazioni, infortuni,
notizie dell'ultima ora). Proporre il piu' caro dei due equivarrebbe a
dichiarare una value bet, che non e' quello che l'app sta facendo.

Ordine finale: **probabilita'** se il divario supera 5 punti → **quota del
book** se sono vicini → punteggio della fusione solo se anche le quote sono
pari.


### 2026-07-27 — `MG 3-6 totali` al posto di `O3.5`

Chiesto da Rossi. Stesso territorio — partita da molti gol — ma con un tetto
sopra: `O3.5` si perde solo se la partita finisce sotto i 4 gol, `MG 3-6` copre
il tratto centrale senza dipendere dalle goleade estreme.

Catalogo sempre a 54 mercati. `O3.5` esce, `MG 3-6 totali` entra. Allineati
anche l'elenco dentro `apply_scenario_result` e lo storico per scenario, che e'
stato ribackfillato per il mercato nuovo sulle 5.160 partite.

Nessun effetto sul verdetto finale: ne' `O3.5` ne' i multigol sono nella
whitelist. Cambia solo cosa vede il ranking strutturale — che e' esattamente
quello che Rossi ha chiesto ("nel ranking possono rimanere tutti, nel verdetto
non devono comparire").


### 2026-07-27 — Il verdetto finale esce solo dai mercati che Rossi gioca

Lista decisa da lui, 17 mercati:
`1X`, `X2`, `GG`, `NG`, `O1.5`, `U3.5`, `1 + O2.5`, `2 + O2.5`, `GG + O2.5`,
e le combo `DC 1X/X2` con `O1.5`, `O2.5`, `U3.5`, `GG`.

**Fuori**: tutte le combo con **DC 12** (copre due esiti su tre), i multigol
semplici e le combo di multigol, il segno secco, `U1.5` / `U2.5` / `O3.5`.
Il ranking strutturale continua a mostrarli tutti — serve a capire cosa pensa
il motore — ma la giocata consigliata esce solo dalla lista.

Rivista di conseguenza l'esclusione decisa ieri (punto A): non piu' tutte le
combo "miste", ma solo quelle costruite sul `DC 12`. Le combo con `1X` / `X2`
rientrano, perche' Rossi le gioca.

**Costo misurato** (583 partite, pick = mercato piu' probabile fra quelli
ammessi):

| Soglia | Tutto il catalogo | Solo la lista | Quota media |
|---|---|---|---|
| 1,40 | 56,6% | 54,0% | 1,45 → 1,56 |
| 1,50 | 63,0% | **55,2%** | 1,54 → 1,68 |
| 1,60 | 55,9% | 51,5% | 1,64 → 1,79 |
| 1,75 | 55,4% | 47,9% | 1,81 → 1,94 |

La precisione **scende** — a 1,50 di quasi 8 punti — e la quota media sale.
Erano i multigol a reggere la precisione: gia' misurato il 26/07, toglierli
costa circa 8 punti. Il confronto pero' e' teorico: un pick che l'utente non
giocherebbe vale zero, non il 63%.

**Da valutare**: `O2.5` secco e il segno secco `1` / `2` sono fuori dalla lista
ma hanno probabilita' sempre **maggiore** delle rispettive combo `1 + O2.5` /
`2 + O2.5`, che invece sono dentro. Su Hjk - Tps il pick vincente era proprio
`1` al 69%. Riammetterli costerebbe nulla e alzerebbe la precisione.


### 2026-07-27 — Il verdetto oscillava al variare della soglia

Segnalato da Rossi su Nacional Potosi - Real Tomayapo (finita 4-1): a soglia
1,40 il pick era `NG`, a 1,50 diventava `GG`, a 1,60 tornava `NG`. Non ha senso:
alzando la soglia si tolgono mercati, non se ne aggiungono, quindi il pick non
dovrebbe andare avanti e indietro.

**Causa.** Il punteggio della fusione assegna bonus in base alla POSIZIONE che
un mercato occupa nelle tre classifiche. Alzando la soglia si rimuovono i
mercati piu' economici e tutti gli altri **salgono di posizione**: il punteggio
cambia anche se la loro probabilita' e' rimasta identica. `NG` passava da
STRUTT #6 a STRUTT #3 senza che nulla fosse cambiato in quella partita.

**Il problema piu' grave sotto.** A soglia 1,40 la fusione sceglieva `NG` al
**50%** scavalcando `MG 1-3 casa + MG 0-2 ospite` al **64%**, solo perche' NG
aveva due sistemi concordi. E' il contrario dell'obiettivo dichiarato
("massima probabilita' sopra la soglia"), ed e' la stessa incoerenza gia'
corretta nel motore con il punto C: era rimasta nella fusione.

**Correzione.** Il verdetto si ordina ora per probabilita' vera. Il punteggio
della fusione — bonus di concordanza compreso — decide solo fra mercati entro
**5 punti** di probabilita': li' e' un vero spareggio, non un ribaltamento.

Su quella partita: a 1,50 il pick era `GG`, che ha **vinto** sul 4-1; a 1,40 e
1,60 era `NG`, che ha perso. L'avviso della soglia consigliata diceva "non
conviene superare 1,50", e aveva ragione.

**Da verificare sul campo**: la fusione vive nel frontend e non e' rigiocabile
sulle 583 partite di test come il motore.


### 2026-07-26 — Avviso sulla soglia massima consigliata, partita per partita

Chiesto da Rossi. Il "muro" oltre il quale alzare la soglia compra solo rischio
**non e' uguale per tutte le partite**: dove c'e' una favorita netta si trovano
mercati al 65% anche a 1,60, in una equilibrata gia' a 1,50 il meglio
disponibile scende sotto la monetina.

`predict.ts` calcola ora il pick a tutte e quattro le soglie e restituisce
`soglia_consigliata` + `soglie_dettaglio`. Il frontend mostra un avviso giallo
quando la soglia scelta la supera, dicendo cosa uscirebbe e con che
probabilita', e marca con ⚠ le soglie oltre il consiglio. **Non blocca niente**:
la scelta resta dell'utente.

**Regola**: la soglia piu' alta a cui il pick ha ancora probabilita' >= 58%.
Il 58% e' misurato, non scelto a occhio — su 583 partite di test:

| Soglia della regola | Dentro il consiglio | Oltre il consiglio |
|---|---|---|
| 55% | 59,1% | 54,6% |
| **58%** | **59,7%** | **55,7%** |
| 60% | 58,8% | 57,2% |

Il 58% da' la separazione migliore con una distribuzione sensata dei consigli
(1,50 nella maggior parte dei casi, 1,60 dove la partita lo permette).

**Nota che merita attenzione**: nella stessa analisi i pick con probabilita'
dichiarata **>= 65% riescono solo il 54,4% delle volte**, peggio della fascia
60-65% (60,1%) e 55-60% (59,4%). C'e' overconfidence in cima alla scala, su 217
casi. Vale la pena capire da dove viene — sospetto i multigol con range molto
larghi, dove l'indipendenza fra gol casa e gol ospite assunta da Poisson regge
meno.


### 2026-07-26 — A+C: via le combo miste, ranking ordinato per probabilita'

Decise da Rossi dopo aver visto i numeri.

**A — Combo "miste" escluse.** Sono quelle che uniscono un segno / doppia
chance / GG a un Over-Under (`DC 12 + O2.5`, `1 + O2.5`, `GG + O2.5`...). Non
hanno un prezzo nel file Sisal e Rossi non le gioca. Le combo di soli multigol
restano: quelle le aveva chieste lui.
Costo misurato: **zero**. A nessuna soglia la precisione cambia di un decimo,
perche' non vincevano quasi mai il primo posto.

**C — Il ranking non e' piu' ordinato per punteggio ma per probabilita' vera.**
Il punteggio mescolava coverage, fragilita', bonus strutturali e correttivo
storico, e finiva per mettere primo un mercato meno probabile di quello sotto.
Su Hjk - Tps era primo `MG 2-4 casa` al 59% con quota stimata, mentre `1` stava
secondo al **69% con quota reale 1,48** — ed e' finita 1-0.
Il punteggio resta calcolato e resta nel campo `score`: cambia solo il criterio
di ordinamento, quindi tornare indietro e' una riga.

**Effetto misurato** (583 partite di test):

| Soglia | Prima | Dopo |
|---|---|---|
| 1,40 | 62,3% | **57,3%** |
| 1,50 | 61,6% | **63,3%** |
| 1,60 | 54,0% | **55,9%** |
| 1,75 | 49,7% | **55,1%** |

Migliora dove Rossi gioca davvero e peggiora di 5 punti a 1,40. Il nuovo punto
migliore della curva e' **1,50 → 63,3% a quota media 1,54**: la soglia 1,40 e'
ora da evitare.

### 2026-07-26 — Le quote delle combo erano il PRODOTTO delle due quote

Seconda parte dello stesso problema di stamattina, in un punto diverso del
codice. `comboOdd()` per i mercati con `+` moltiplicava le due quote reali:
`DC 12 + O2.5` diventava 1,18 x 1,48 = **1,746**, e veniva mostrato con la `@`
come se fosse un prezzo letto dal file Sisal — dove quella combo non esiste.

Moltiplicare vale solo per eventi **indipendenti**. "Non finisce in pareggio" e
"almeno 3 gol" non lo sono: crescono insieme. Il prodotto sovrastima la quota.
La stima di Poisson tiene conto della correlazione perche' conta i risultati
esatti in cui entrambi gli eventi si verificano: sulla stessa partita da
**1,66** invece di 1,746.

Corretto anche il flag: `odd_estimated` era true solo quando `comboOdd`
restituiva null, quindi le combo passavano per prezzi reali. Ora una quota e'
marcata reale **solo** se il bookmaker la fornisce per quel mercato esatto —
14 mercati su 54.

**Misurato prima di decidere** (583 partite di test, tre cataloghi a confronto):

| Soglia | Tutti i 54 | Senza le combo `+` | Solo quote reali (14) |
|---|---|---|---|
| 1,40 | 62,3% | **62,1%** | 53,9% |
| 1,50 | 61,6% | **61,4%** | 54,0% |
| 1,60 | 54,4% | **53,5%** | 49,1% |

Togliere le combo costa **quasi nulla**. Togliere anche i multigol costa
**8 punti**: sono loro a reggere la precisione, non le combo.

### 2026-07-26 — Correggere un risultato non avvelena piu' lo storico

Emerso da Rossi: su Mariehamn - Ac Oulu aveva salvato `1-0`, ma la partita era
finita `1-1`.

**Il problema.** `applyMatchResult` non aveva nessun controllo su un risultato
gia' presente. Conseguenze:
- **risalvare la stessa partita** contava tutto una seconda volta;
- **correggere** un risultato sbagliato lasciava i conteggi vecchi al loro
  posto e ci sommava sopra quelli nuovi.

Con l'apprendimento per scenario attivo (Fase 3) non e' un dettaglio: quei
numeri finiscono nei pronostici di tutte le partite con quote simili. Nel caso
concreto la differenza e' grossa — il pick era `MG 2-4 totali`, che su un 1-0
risulta PERSO e su un 1-1 risulta VINTO.

**Correzione.**
- Stesso risultato risalvato -> non si conta niente (idempotente).
- Risultato diverso -> si **annullano** prima i conteggi del vecchio, poi si
  applicano quelli del nuovo.
- `apply_scenario_result` e `increment_system_score` hanno ora un parametro di
  segno (`p_sign`: +1 applica, -1 annulla), con `greatest(0, ...)` per non
  andare mai sotto zero.

**Resta scoperto**: `market_scores` e `family_counters` (il ramo che si
aggiorna solo quando esiste un pronostico AI) non hanno ancora l'annullamento.
Alimentano il prompt dell'IA, non il motore, quindi l'impatto e' minore — ma va
fatto.

### 2026-07-26 — La lista del pre-pronostico non mostra piu' i mercati dell'IA

La didascalia diceva "questa lista NON tiene conto del pronostico AI", ma in
cima compariva ancora `MG 1-4 totali` marcato `AI_ONLY`: `rankPicks` unisce i
mercati dell'IA alla lista. Dal voto erano gia' stati esclusi; ora spariscono
anche dalla vista, cosi' la sezione mostra il parere del pre-pronostico e
basta. I mercati dell'IA hanno gia' la loro sezione piu' sotto.

### 2026-07-26 — Pick senza quota e falsa concordanza: tre buchi chiusi

Segnalato da Rossi: su Vasco Da Gama - Mirassol la giocata consigliata era
diventata `MG 1-4 totali`, **senza nessuna quota accanto**, con "CONCORDANZA
FORTE 2/3 — AI #1, PRE #1". Tre difetti distinti, tutti veri.

**1. Un mercato proposto solo dall'IA veniva contato anche come voto del
pre-pronostico.** `rankPicks` unisce i mercati dell'IA alla lista PRE
(`source: "ai"`), e la fusione contava tutta la lista come voto "pre". Cosi'
`MG 1-4 totali`, proposto da UN sistema solo, risultava "2 su 3". E' lo stesso
doppio conteggio corretto poco prima con il bonus `pre+ai`: era rimasta l'altra
meta'. Ora gli elementi `source === "ai"` non danno il voto "pre".

**2. Un pick senza prezzo passava il filtro.** Il controllo era
`if (b.odd === undefined || b.odd === null) return true` — lasciava passare
proprio i mercati di cui non si conosceva la quota. `MG 1-4 totali` ha quota
stimata **1,17**, sotto qualsiasi soglia: sarebbe dovuto sparire, invece e'
arrivato in cima proprio perche' non aveva prezzo. Ora un pick senza quota
determinabile viene scartato: se non si sa quanto paga, non e' giocabile.

**3. La quota di riserva si cercava solo nel top 20.** I mercati che il motore
scarta restavano senza prezzo. `predict.ts` ora restituisce `market_odds` con
la quota di **tutti** i 54 mercati, reale o stimata.

**In piu'**: nella tabella mandata all'IA i mercati sotto la soglia dell'utente
ora vengono **tolti**, non marcati. Marcarli non era bastato — l'IA ha scelto
`MG 1-4 totali` ignorando l'avviso `⛔ SOTTO LA SOGLIA`. Se un mercato non e'
selezionabile, il modo sicuro per non farlo scegliere e' non mostrarglielo.

*Lezione*: le istruzioni al modello sono un suggerimento, non una garanzia.
Quando un vincolo deve valere sempre, va imposto dal codice.

### 2026-07-26 — Il pre-pronostico smette di fare eco all'IA

Trovato rispondendo a una domanda di Rossi: perche' su Vasco Da Gama - Mirassol
il pick del pre-pronostico era `X2` prima di premere "Pronostico AI" e
diventava `GG` dopo, senza che fosse cambiata nessuna quota?

**Causa.** In `rankPicks` c'era `if (p.source === "pre+ai") score += 0.30`: i
mercati nominati dall'IA salivano nella classifica del pre-pronostico. Quindi
il pre-pronostico veniva **riordinato dall'IA**, e la fusione lo contava
comunque come TERZO parere indipendente. Una "CONCORDANZA 2/3 = AI + PRE" era
spesso lo stesso parere contato due volte.

E' lo stesso errore evitato in mattinata sui multigol: due sistemi che si
copiano non sono due conferme.

**Correzione.** Tolto il bonus. L'etichetta `pre+ai` resta come informazione a
schermo, ma non influenza piu' l'ordinamento: il pre-pronostico si regge ora
solo sulle quote reali del bookmaker e sul win-rate storico — l'unica cosa che
sa davvero, e l'unica che il motore Poisson non guarda.

**Cosa aspettarsi**: la lista del pre-pronostico non cambia piu' dopo il click
sul Pronostico AI, e alcune concordanze scenderanno da "2 su 3" a "1 su 3".
E' corretto: erano gonfiate.

**Non misurabile offline**: la fusione vive nel frontend e non e' rigiocabile
sulle partite storiche come il motore. Va verificata sul campo.

**Nota sull'X2 di quella partita**: non era favorito. Con lambda 1,56 / 1,01 la
probabilita' vera di X2 e' 49,9% (vittoria casa 50,1%), quindi la quota equa
sarebbe 2,00 mentre il book dava 1,67. Il motore lo teneva fuori dai primi
venti a ragione: sopra c'era una dozzina di multigol fra il 55% e il 67%.

### 2026-07-26 — Tabella per l'IA: ordinata per probabilita' e con la soglia segnalata

Due rifiniture emerse dalla prima prova sul campo (Vasco Da Gama - Mirassol).

**1. La lista era in ordine di catalogo**, quindi i multigol finivano sepolti a
meta' elenco e l'IA continuava a proporre i soliti Over/GG anche quando avevano
numeri peggiori. Su quella partita `MG 1-3 totali` aveva la probabilita' piu'
alta fra i mercati selezionabili (67%) e l'IA non l'ha nemmeno nominato. Ora la
tabella e' ordinata per probabilita' decrescente.

**2. L'IA sprecava la prima scelta su mercati non selezionabili.** Il suo
pronostico principale era `O1.5`, che a quota 1,33 sta sotto la soglia minima
dell'utente e viene scartato a valle: infatti sullo schermo e' arrivato GG, non
O1.5. Ora ogni voce sotto soglia e' marcata `⛔ SOTTO LA SOGLIA, NON
SELEZIONABILE` e la regola glielo vieta esplicitamente.

**Conferma che il lavoro precedente funziona**: nelle sue motivazioni l'IA ha
citato "Probabilita' 73%" per O1.5 e "50%" per GG — che sono esattamente i
valori calcolati dal motore e passati nella tabella, non stime sue. Prima li
inventava.

### 2026-07-26 — BUG GRAVE: le quote delle combo erano sbagliate

Segnalato da Rossi guardando New York RB - Charlotte. Nella lista del
pre-pronostico comparivano `GG + O2.5 @ 1.40`, `DC 1X + O2.5 @ 1.40`,
`1 + O2.5 @ 2.20` — e la stessa quota sbagliata finiva sulla GIOCATA
CONSIGLIATA.

**Causa.** `realOddFor()` ricavava la quota di una combo prendendo il
**massimo fra i componenti**. E' sbagliato di netto: il massimo fra due quote
e' la quota dell'evento piu' probabile dei due, mentre una combo richiede che
si verifichino ENTRAMBI — la sua quota e' sempre piu' alta di tutti i
componenti, mai uguale al maggiore. Valori reali su quella partita:

| Mercato | Mostrato | Corretto |
|---|---|---|
| GG + O2.5 | 1,40 | **1,90** |
| DC 1X + O2.5 | 1,40 | **1,96** |
| DC 12 + O2.5 | 1,40 | **1,82** |
| 1 + O2.5 | 2,20 | **3,08** |
| DC 1X + GG | 1,40 | **1,90** |

**Da dove veniva.** Dall'euristica originale nel frontend
(`quickPredictionFamily`), dove `Math.max(o1X, oO15)` serviva solo a ordinare
una lista e nessuno guardava il numero. Portandola lato server e collegandola
alla fusione, quel numero ha iniziato a fare tre cose per cui non era adatto:
comparire come quota della giocata consigliata, passare il filtro di quota
minima, e ordinare i voti del pre-pronostico. Un errore innocuo e' diventato
dannoso cambiando contesto.

**Correzione.** `realOddFor()` ora restituisce solo la quota LETTA dal file
del bookmaker, per i singoli. Sulle combo l'euristica si astiene — che e'
anche cio' che le lascia la sua indipendenza dal motore. Per le combo la quota
corretta la calcola gia' `estimateMarketOdd` sulla distribuzione di Poisson,
che tiene conto della correlazione fra i due eventi.

L'euristica passa da ~26 mercati valutati a **14** (i soli con prezzo vero),
di cui ne promuove una decina. Meno mercati, ma nessun numero inventato.

**Nota su cosa NON era rotto**: le quote stimate dei multigol sono corrette e
verificate sulle 5.160 partite storiche entro 1-2 punti (MG 2-4 totali 60,8%
stimato contro 59,9% reale). Le due cose viaggiavano su strade diverse: la
stima del motore era giusta, il massimo-fra-componenti del pre-pronostico no.

### 2026-07-26 — L'IA vede tutti i 54 mercati con i numeri gia' calcolati

Ultimo pezzo del lavoro sulla fusione. Prima l'IA proponeva 3-5 mercati
scegliendoli a memoria, quindi i multigol non li nominava quasi mai: nella
fusione risultavano "poco condivisi" non perche' fossero deboli, ma perche'
nessuno li aveva mai messi sul tavolo.

Ora nel prompt entra il **catalogo completo**: tutti e 54 i mercati con
probabilita' calcolata dal motore sulla distribuzione completa, quota (reale, o
stimata e marcata con `~`) e percentuale storica dello scenario. Circa 500
token in piu' per chiamata, trascurabili.

Il compito dell'IA cambia di natura: non stima piu' probabilita' — cosa che un
modello linguistico non sa fare in modo affidabile — ma **giudica** numeri gia'
calcolati, che e' esattamente cio' in cui e' bravo. E deve scegliere copiando i
nomi dalla lista, quindi non puo' piu' inventare mercati fuori catalogo.

Modificata anche la regola 4 del PIN strutturale: prima diceva di proporre solo
mercati coerenti col PIN, il che avrebbe escluso a priori meta' del catalogo
appena aggiunto. Ora il PIN serve a giudicare la coerenza, mentre l'elenco di
cosa e' proponibile e' il catalogo.

**Da verificare sul campo**: come risponde il modello a una lista di 54 voci non
e' verificabile offline. Il parsing della risposta resta invariato
(`playable_markets` + `main_prediction`), quindi se il modello ignorasse le
nuove istruzioni il comportamento tornerebbe semplicemente quello di prima,
senza rotture.

### 2026-07-26 — Concordanza consapevole delle astensioni; euristica PRE lato server

**Il problema.** Il bonus di concordanza contava quanti sistemi avevano scelto
un mercato, senza chiedersi se gli altri POTESSERO sceglierlo. L'euristica PRE
ragiona sulle quote reali del bookmaker, e per i **16 multigol semplici** un
prezzo non esiste nel file Sisal: quei mercati risultavano "poco condivisi" non
perché l'euristica li bocciasse, ma perché non aveva modo di esprimersi.
Penalità sistematica contro i multigol — ed è il motivo per cui in
Atletico Pr–Internacional il verdetto ha scelto NG (coverage 53%) invece di
MG 1-2 casa, che nel ranking strutturale era primo con 59%.

**Cosa è cambiato**
- `preHeuristicRanking()` valuta l'intero catalogo invece di una lista fissa di
  ~18 candidati: ogni mercato, combo comprese, per cui **tutti** i componenti
  hanno una quota vera. In pratica da ~18 a ~26 mercati.
- `preEligibleMarkets()` distingue "l'euristica lo boccia" da "l'euristica non
  può dire niente".
- `predict.ts` restituisce `pre_ranking` e `pre_eligible`. Il frontend usa
  quelli invece di ricalcolare l'euristica nel browser: **una sola
  implementazione** al posto di due copie da tenere allineate a mano (il rischio
  segnalato in Fase 0 sparisce).
- La concordanza si misura solo fra i sistemi che potevano votare. Unanimità
  fra tre vale +8, unanimità fra due (perché il terzo si è astenuto) vale +4,
  due su tre resta +2,5.

**Perché l'euristica NON è stata estesa anche ai multigol.** Sarebbe stato
facile: basta usare la quota che stimiamo noi. Ma quella stima deriva dalla
distribuzione di Poisson, cioè dalla stessa probabilità con cui ragiona il
motore strutturale: ordinare i multigol con quella significa fabbricare un
secondo voto identico al primo. La concordanza "2 su 3" diventerebbe automatica
e priva di significato — e visto che è il bonus di concordanza a decidere il
pick, avremmo peggiorato la fusione credendo di renderla più equa.
L'indipendenza dell'euristica PRE viene esattamente dal fatto che guarda solo
prezzi veri. Su quello che non ha prezzo, si astiene.

**Non ancora fatto**: mandare all'IA tutti i 54 mercati con la probabilità già
calcolata, chiedendole *approvo / neutro / respingo* su ciascuno invece di farle
proporre 3-5 mercati liberamente. Va provato con una chiamata vera al modello,
quindi aspetta lo sblocco dei deploy.

### 2026-07-26 — Calendario ancora bloccato: seconda causa

La correzione precedente (funzione SQL `matches_distinct_days`) era giusta ma
non bastava: **PostgREST tiene una cache dello schema**, e finché non la
ricarica una funzione appena creata con una migration risponde 404. Le RPC
nuove (`matches_distinct_days`, `increment_system_score`,
`apply_scenario_result`) erano quindi invisibili al codice.

Prova del fatto: `system_scorecard` era rimasta **vuota** anche dopo che erano
stati salvati dei risultati su partite che avevano i tre pick registrati — le
chiamate RPC fallivano e venivano assorbite dai `try/catch` best-effort, in
silenzio. Stessa sorte per l'aggiornamento incrementale dello storico.

Fatto: `notify pgrst, 'reload schema'`.

E soprattutto: `matches-days` non dipende più da una strada sola. Se la RPC non
risponde, ricade su due letture con `limit` ESPLICITO (una dal giorno più
vecchio, una dal più recente) e le unisce, così i giorni in coda — le partite
future, quelle che servono — arrivano comunque.

*Lezione da ricordare*: dopo una migration che crea funzioni, va ricaricata la
cache di PostgREST, altrimenti le RPC nuove falliscono in silenzio. E un
`try/catch` best-effort nasconde proprio questo tipo di guasto: se una scrittura
è "opzionale", il suo mancato funzionamento non si vede finché non si va a
controllare la tabella.

### 2026-07-25 (notte) — Calendario bloccato, bug combo, combo multigol simmetriche

**1. BUG GRAVE: il calendario si fermava al 25 luglio.** Caricando un Excel
nuovo le partite entravano nel database ma i giorni successivi non comparivano
fra quelli selezionabili.

Causa: `matches-days` scaricava TUTTE le righe di `matches` (`select=day`) per
poi ricavarne i giorni distinti in JavaScript. **PostgREST tronca la risposta a
1000 righe.** Con 1.739 partite ordinate per giorno crescente, la millesima
cadeva esattamente sul 2026-07-25 — quindi i 29 giorni successivi non
arrivavano mai al frontend. Nessun messaggio di errore: la lista arrivava,
semplicemente incompleta.

Correzione: nuova funzione SQL `matches_distinct_days()`, il calcolo lo fa il
database e tornano 61 righe invece di 1.739. Il tetto non è più raggiungibile
nemmeno con anni di partite.

*Classe di bug da ricordare*: qualsiasi `pgGet` senza `limit` esplicito su una
tabella che può superare le 1000 righe è a rischio, e fallisce **in silenzio**.
L'unico altro punto simile (`results-fetch`) filtra per lista di id, quindi è
al sicuro.

**2. BUG: le combo con multigol venivano valutate male.**
`evaluateMarketStrict` controllava i multigol PRIMA di spezzare le combo sul
`+`. Risultato: `MG 1-2 casa + MG 0-2 ospite` su un **2-4** rispondeva
"vinto" — prendeva il primo range (1-2), vedeva la parola CASA e ignorava
tutto quello che seguiva il `+`. Lo split sul `+` è stato spostato in cima,
prima di ogni altro controllo. `marketEval.ts` era invece già corretto.

Corretto PRIMA di aggiungere le combo nuove: lasciandolo, lo storico per
scenario avrebbe imparato risultati falsi su tutta la famiglia — cioè avrebbe
disfatto la Fase 3 invece di sfruttarla.

**3. Catalogo da 49 a 54 mercati: le combo multigol casa + ospite.**
Aggiunte **simmetriche**, come richiesto: per ogni combinazione esiste il suo
specchio, così una partita dominata dall'ospite è coperta come una dominata
dalla casa.

| Combo | Vince | Quota stimata |
|---|---|---|
| MG 1-3 casa + MG 0-2 ospite | 59,9% | 1,53 |
| MG 1-2 casa + MG 0-3 ospite | 55,2% | 1,66 |
| MG 0-2 casa + MG 1-3 ospite | 53,9% | 1,70 |
| MG 0-3 casa + MG 1-2 ospite | 53,0% | 1,73 |
| MG 1-2 casa + MG 0-2 ospite | 50,0% | 1,83 |

Scartate le altre 7 combinazioni proposte: `0-3 + 0-3` vale 1,03 e `0-3 + 0-2`
vale 1,14 (non superano mai nessuna soglia, sarebbero peso morto), mentre
`1-3+1-2`, `2-4+0-3`, `2-4+0-2`, `1-2+1-2`, `2-4+1-2` stanno tutte sotto il 40%
di riuscita.

`scenario_market_scores` ribackfillata per i 5 mercati nuovi (864 righe, 54
mercati) e `apply_scenario_result` aggiornata perché l'apprendimento
incrementale li includa.

**Effetto sul test set** (583 partite): 1,60 da 54,0% a 54,4% senza storico e
da 57,1% a 57,5% con storico; 1,75 da 49,7% a 50,1%. Miglioramenti piccoli,
dovuti quasi tutti alla correzione del bug 2.

### 2026-07-25 (sera) — FASE 3: lo storico entra davvero nel motore

**Il problema.** Il "ML boost" esistente spostava lo score di ±10% solo per i
mercati con win-rate storico ≥70% o ≤30%, su base FAMIGLIA. Misurato: il 71%
delle righe storiche stava nel mezzo e non produceva alcun effetto, e ±10% non
poteva comunque nulla contro euristiche che moltiplicano per 1,35 o 0,45. In
pratica 5.160 partite non avevano voce in capitolo.

**Cosa c'è ora.**
- Nuova tabella `scenario_market_scores` (scenario × mercato), popolata dalle
  5.160 partite storiche: 784 righe, 252.840 osservazioni. Lo scenario è
  forza della favorita × gol attesi (16 combinazioni), non più le 8 famiglie,
  che mescolavano partite troppo diverse.
- Nuova funzione SQL `eval_market_sql` (riproduce `evaluateMarketStrict`) usata
  per il backfill, e `apply_scenario_result` che aggiorna tutti i 49 mercati in
  **un solo round-trip** — con 49 chiamate separate il salvataggio multiplo
  dalla Schedina avrebbe fatto scadere la function.
- `predict.ts` passa al motore lo storico dello scenario invece di quello della
  famiglia; `applyResult.ts` aggiorna la tabella a ogni risultato inserito, per
  **tutti** i mercati e non solo per quelli proposti dall'IA (che darebbe una
  statistica distorta dalle scelte del sistema).
- Il correttivo nel motore non è più una soglia secca ma una media pesata:
  `k = n/(n+80)`, `mista = coverage×(1−k) + storico×k`, `score ×= mista/coverage`.
  Con poche partite conta il modello, con centinaia conta lo storico. Nessun
  mercato resta scoperto.

**Verifica su test set vero.** Le statistiche storiche sono state ricalcolate
**escludendo** le 583 partite di prova (4.602 partite di training), altrimenti
il correttivo si sarebbe misurato su sé stesso. Trascrizione verificata con
checksum esatto contro il database.

| Soglia | Senza storico | Con storico | Quota media |
|---|---|---|---|
| 1,40 | 62,3% | **63,6%** | 1,56 → 1,58 |
| 1,50 | 61,6% | **65,0%** | 1,62 → 1,64 |
| 1,60 | 54,0% | **57,1%** | 1,86 → 1,90 |
| 1,75 | 49,7% | 49,7% | 2,08 → **2,25** |

Migliora a tre soglie su quattro, e alla quarta lascia la precisione invariata
alzando la quota. Il risultato **non dipende dalla taratura**: con la costante
di shrink a 30, 80 o 200 il miglioramento resta, quindi non è un artefatto.

Provata e **scartata** una variante additiva (bonus proporzionale a
`storico − modello`): crolla a 46-52%, perché premia i mercati su cui storico e
modello sono in disaccordo, che sono soprattutto quelli a bassa probabilità.

**Non fatto in questa fase**: i pesi della fusione fra i tre sistemi
(10 / 5 / 8 + concordanza) restano quelli scritti a mano. `system_scorecard` è
stata creata in Fase 0 ma è ancora vuota: si riempie con le partite vere da qui
in avanti, e solo allora quei pesi potranno essere misurati invece che scelti.

### 2026-07-25 (sera) — FASE 2: soglia di quota scelta dall'utente

**Cosa cambia.** La quota minima non è più il `1.4` fisso passato a
`structuralAnalysis`. Nuovo endpoint `odd-settings` (GET/POST, chiave
`min_odd` nella tabella `settings` già esistente), `predict.ts` la legge (o
accetta `?minOdd=` in query per confronti rapidi) e la restituisce nella
risposta; il frontend la passa anche a `buildFinalVerdict` e mostra un
selettore 1,40 / 1,50 / 1,60 / 1,75 sopra la giocata consigliata.

Curva misurata sul motore vero, 583 partite storiche:
| Soglia | Precisione | Quota media |
|---|---|---|
| 1,40 | 62,3% | 1,56 |
| 1,50 | 61,6% | 1,62 |
| 1,60 | 54,0% | 1,86 |
| 1,75 | 49,7% | 2,08 |

Il gradino vero è fra 1,50 e 1,60: −7,6 punti di precisione per +24 centesimi
di quota. Nessuna partita resta senza pick a nessuna soglia.

**Cosa NON è stato cambiato, e perché.** La scaletta prevedeva anche di
sostituire il criterio di scelta con "massima probabilità sopra la soglia".
Provato e misurato prima di scriverlo:

| Soglia | Punteggio attuale | Massima probabilità pura |
|---|---|---|
| 1,40 | **62,3%** | 57,1% |
| 1,50 | **61,6%** | 60,5% |
| 1,60 | 54,0% | **55,2%** (quota media 1,67 contro 1,86) |
| 1,75 | 49,7% | **53,2%** (quota media 1,84 contro 2,08) |

Non c'è un vincitore: alle soglie basse perde nettamente, a quelle alte vince
di poco (1-3 punti, dentro il rumore su 583 partite) ma **abbassando la quota
media** — cioè dando all'utente meno di quello che ha chiesto alzando la
soglia. Criterio lasciato invariato. Da riesaminare in Fase 3 con i pesi
misurati invece che scelti a mano.

Nota metodologica emersa dal test: ordinare per `coverage` o per
`coverage − 0.5×fragility` dà **risultati identici**, perché per i mercati
sempre decidibili `fragility = 1 − coverage`, quindi il secondo criterio è
monotono nel primo. Non è un vero tie-break: non serve reintrodurlo.

### 2026-07-25 (sera) — Stima della quota per i mercati senza prezzo (multigol)

**Il problema.** Il file Sisal non contiene i multigol, quindi `comboOdd()`
restituiva `null` per tutti. Il filtro "quota minima" nel motore era scritto
come `if (co !== null && co < minOdd) continue`, quindi **un mercato senza
prezzo non veniva mai scartato**: i multigol restavano in gara per forfait ed
erano il 70% dei pick prima della Fase 1, il 90% dopo.

**La soluzione.** L'estimatore esisteva già (`estimateComboOddFromCluster`) ma
era raggiungibile solo per i mercati con un `+` nel nome. Rinominato in
`estimateMarketOdd` e reso raggiungibile per qualsiasi mercato senza prezzo.
Usa la probabilità di Poisson e applica il margine reale **di quella partita**
(somma delle implicite di 1/X/2, tipicamente 1,09 — misurato sulle 5.160
storiche: 8,8% su U/O 2.5, 8,9% su GG/NG, 9,5% su 1X2).

**Trappola evitata, da non reintrodurre**: la quota stimata NON entra nel
calcolo dell'Expected Value. Sarebbe circolare — la quota deriva dalla stessa
probabilità con cui si calcolerebbe l'EV, quindi ogni mercato stimato avrebbe
EV costante pari a circa −9%, facendo scattare su tutti il malus
`ev <= -0.05 → score *= 0.65`. L'EV resta calcolato solo su quote reali.

**Effetto misurato** (583 partite, soglia di default 1.40):
| | Precisione | Quota media | Pick con un prezzo |
|---|---|---|---|
| Solo Fase 1 | 68,8% | — | 10% |
| Con stima quota | **62,3%** | 1,56 | **100%** |

La precisione **scende**, ed è corretto così: il 68,8% veniva da mercati come
`MG 1-4 totali` (85% di riuscita ma quota reale intorno a 1,25), che ora il
filtro scarta. Per confronto, la stessa simulazione fatta con i soli 10
mercati base dava 58,4% a soglia 1,40 — quindi i multigol prezzati
correttamente aggiungono davvero valore.

Curva soglia → precisione, misurata sul motore vero:
| Soglia | Precisione | Quota media |
|---|---|---|
| 1,40 | 62,3% | 1,56 |
| 1,50 | 61,6% | 1,62 |
| 1,60 | 54,0% | 1,86 |
| 1,75 | 49,7% | 2,08 |

Nessuna partita resta senza pick a nessuna soglia. Questa curva è la base della
Fase 2 (soglia scelta dall'utente).

**Lato interfaccia**: le quote stimate sono marcate `odd_estimated` e mostrate
con `≈` e la dicitura "(stimata)", per non farle confondere con un prezzo
reale del bookmaker.

### 2026-07-25 (sera) — FASE 1: probabilità vere al posto del cluster tagliato

**Cosa cambia.** `coverage` e `fragility` non si calcolano più sugli 8
risultati del cluster centrale ma sulla distribuzione completa
(`fullDistribution`, 49 celle). Il cluster centrale resta esattamente com'era
per la parte mostrata a schermo, comprese le liste "coperto da" / "rotto da"
(sulla distribuzione completa sarebbero elenchi di 40+ punteggi, illeggibili).

**Perché.** Gli 8 risultati coprivano in media il 60-75% della probabilità
totale, e il pezzo tagliato non era neutro: i risultati con uno zero sono
pochi e concentrati e finivano quasi tutti dentro il taglio, quelli da GG/Over
sono tanti e piccoli e restavano fuori. Misurato sulle 5.160 partite storiche:
NG dato al 55,6% contro un 46,2% reale, O2.5 dato al 34,8% contro un 51,2%
reale. Sulla distribuzione completa lo stesso modello dà 49,5% e 51,0%.

**Effetto misurato** (rigioco su 583 partite reali, campione stratificato):
| | Precisione del pick #1 | 
|---|---|
| Prima | 63,5% (370/583) |
| Dopo | **68,8% (401/583)** |

Il pick cambia sul **72%** delle partite. Mix dei mercati scelti:
`Under 17% → 0%`, `NG 4% → 2%`, `Over 0% → 8%`, `MG 70% → 90%`.

**Da tenere d'occhio (due effetti collaterali noti, non risolti qui)**
1. `MG 70% → 90%`: senza quota nota i multigol non sono filtrabili e vincono
   per forfait. È il motivo per cui la stima teorica della quota MG è il
   prossimo passo, prima della Fase 2.
2. In `buildFinalVerdict` la soglia `robust` (`coverage >= 0.60 &&
   fragility <= 0.35`) prima scattava nell'**87%** delle partite — cioè era di
   fatto sempre vera e non distingueva niente. Con i numeri onesti scatta nel
   **51%**. Le soglie sono state lasciate come sono perché ora dicono la
   verità; la ricalibratura dei pesi della fusione è materia della Fase 3, dove
   verranno misurati invece che scelti a mano. Stesso discorso per
   `COVERAGE_WEIGHT = 30`: il contributo medio passa da 7,80 a 4,95.

### 2026-07-25 (sera) — FASE 0: pagella dei tre sistemi (solo misurazione)

Primo passo di una roadmap in 5 fasi decisa con Rossi dopo un audit completo
del motore. **Questa fase non cambia nessun pronostico**: aggiunge solo la
misurazione che serve a decidere le fasi successive con i numeri invece che a
occhio.

**Perché.** L'app fonde tre sistemi (motore Poisson, euristica PRE, IA) con
pesi scritti a mano (10 / 5 / 8 + bonus concordanza 8) che nessuno ha mai
verificato. Il motivo per cui non erano verificabili: l'unico pick salvato su
Supabase era `main_prediction`, che è il pick **dell'IA**. Il pick del motore
e quello dell'euristica giravano e sparivano; il verdetto finale della fusione
non veniva salvato affatto.

**Cosa è stato aggiunto**
- Migration `fase0_pagella_tre_sistemi`: colonne `pick_strutturale`,
  `pick_pre`, `pick_finale`, `pick_finale_prob`, `scenario` su `matches`;
  nuova tabella `system_scorecard` + RPC `increment_system_score`.
  Tutto additivo: nessuna colonna o tabella esistente è stata modificata.
- `lib/scenario.ts`: classifica la partita per forza della favorita ×
  gol attesi (12 scenari). Le soglie sono quelle usate nell'analisi storica —
  cambiarle rende i conteggi vecchi e nuovi non confrontabili.
- `lib/preHeuristic.ts`: porto lato server di `quickPredictionFamily`, che
  vive solo nel frontend. **Va tenuto allineato a mano** con
  `frontend/src/api.ts`, altrimenti la pagella misura un sistema diverso da
  quello che vota.
- `predict.ts`: registra pick strutturale + pick PRE + scenario sulla riga
  della partita (best effort, mai bloccante, mai su partite già concluse).
- `save-verdict.ts` (nuovo endpoint) + `useEffect` in `app/match/[id].tsx`:
  salvano il verdetto finale della fusione. Risolve anche la perdita del pick
  alla riapertura della partita.
- `lib/applyResult.ts`: aggiorna `system_scorecard` per i tre sistemi
  **prima** dell'uscita anticipata `if (!preds.length) return`. Oggi, senza
  un "Pronostico AI", la partita non insegnava niente a nessuno.

**Misurazione già fatta sullo storico** (rigioco del motore vero su 583
partite reali, campione stratificato verificato con checksum):
| Sistema | Precisione |
|---|---|
| Strutturale attuale | 63,5% |
| Strutturale con distribuzione completa (Fase 1) | **68,8%** |
| Euristica PRE | 57,2% |

**Trappola trovata, da risolvere prima della Fase 2**: il 70% dei pick
attuali — e il 90% di quelli del motore corretto — sono mercati multigol
**senza quota nota**, quindi non filtrabili dalla soglia di quota minima e non
valutabili come puntata. La stima teorica della quota MG (Poisson, validata
sullo storico entro 1-2 punti) va quindi anticipata subito dopo la Fase 1.

### 2026-07-25 (continua) — Roadmap punti 1, 2, 3 completati
- **Punto 1**: attivato `ml_adjustment` nel motore (era scritto ma mai
  alimentato). `predict.ts` ora recupera `market_scores` per la famiglia
  della partita (globale + per-campionato sopra soglia 30) e lo passa a
  `structuralAnalysis()`. Commit `975236c`.
- **Punto 2**: storico esteso da 21 a 49 mercati/combo (`STANDARD_MARKETS`
  ora importa `CANDIDATE_MARKETS` da `clusterEngine.ts`, unica fonte di
  verità; `evaluateMarket` generalizzato per qualsiasi range MG X-Y).
  Backfill esteso alle 5.160 partite storiche per i 28 mercati nuovi
  (senza ricontare i 21 originali). `market_scores` passato da 17.013 a
  38.962 righe. Commit `975236c`.
- **Punto 3**: Distribution Engine leggero, deliberatamente solo
  informativo per ora — verificato che solo 922/3392 squadre hanno 5+
  partite (74 con 8+), troppo poco per un correttivo automatico
  affidabile. Nuova funzione SQL `team_goal_stats()` su Supabase (media
  gol fatti/subiti per squadra, casa/trasferta separate, unendo
  `match_results_training` + `matches` così cresce nel tempo).
  `match-history.ts` la espone (soglia minima 5 partite), mostrata in
  `match/[id].tsx` come card informativa esplicitamente etichettata "non
  influenza il pick". Commit `7c9fde3`.

### 2026-07-25 (continua) — Profilo non istantaneo, scroll Schedina
- **Profilo non aggiornava i numeri subito dopo un salvataggio risultato**:
  `marketStatsCache`/`mlStatsCache` non avevano un metodo `invalidate()`
  (TTL 5 minuti stale-while-revalidate). Aggiunto e collegato in tutti i
  punti che salvano un risultato (Schedina: salva tutti / fetch
  automatico / applica revisione; dettaglio partita: salva singolo).
- **Scroll che tornava sempre in cima rientrando dalla Schedina**: l'effetto
  di reset scroll ai cambi filtro girava anche al primo render dopo un
  rimontaggio (comportamento normale di React), annullando il ripristino
  di `savedScrollY`. Aggiunta una guardia "salta il primo run". Commit
  `bf3a62a`.

### 2026-07-25 — Correttivi motore + scoperta file-sbagliato + storico
- **Scoperto e corretto**: i fix "ranking trasparente" del mattino erano
  finiti nel file legacy (`backend/cluster_engine.py`) invece che in quello
  vero (`netlify/functions/lib/clusterEngine.ts`). Riapplicati sul file
  giusto: rimosso il taglio secco coverage<30%, non si nascondono più i
  mercati incoerenti col pick (es. GG quando NG è il pick), ranking alzato
  da 10 a 20 mercati. Commit `e5f738d`.
- Scoperto (non ancora attivato): `clusterEngine.ts` ha già un meccanismo
  Expected Value (`ev = coverage×quota-1`, boost/malus sullo score) e un
  meccanismo `ml_adjustment` che leggerebbe win-rate storico per mercato —
  ma `predict.ts` non gli passa mai i dati storici (`mlScores`), quindi è
  presente nel codice ma dormiente. Da valutare insieme al correttivo
  storico lato frontend per non sovrapporli.
- **Correttivo storico reale** in `buildFinalVerdict`: penalizza il
  divario tra coverage dichiarata (motore Poisson) e win-rate vero della
  famiglia (da `market_scores`), solo oltre una tolleranza di 15 punti.
  Nuova chiamata `api.matchHistory(id)` in `match/[id].tsx`. Soglia minima
  30 partite per usare il dato per-campionato (sotto soglia, troppo
  rumoroso — 639/801 combinazioni famiglia+campionato ne hanno meno di 10),
  altrimenti fallback sullo storico globale per famiglia. Commit `354c978`.
- **Migrazione storico ScoreBlast**: importate 5.160 partite reali (con
  risultato) dall'altro progetto Supabase di Rossi (ScoreBlast) nella
  nuova tabella `match_results_training`, poi classificate per famiglia e
  usate per arricchire `market_scores`/`family_counters` (17.013 righe,
  5.428 partite totali nel sistema di apprendimento).
- **Correttivo coverage reale** in `buildFinalVerdict`: la coverage/
  fragility del motore Poisson ora pesa per qualunque mercato nel ranking
  (non solo la sua top-6), bonus/penalità proporzionale alla distanza dal
  50%. Commit `68965af`.
- **3 bug post-migrazione risolti**: Pronostico AI restituiva testo di
  reasoning troncato invece del JSON (DeepSeek V4 attiva il "thinking
  mode" di default, ora disabilitato per l'opzione Lite) — bug vero
  trovato prima nel file legacy `llmProviders`... vedi sopra; ricerca
  partite riportata a restare sul giorno selezionato; salvataggio
  risultati in Schedina ora invalida le cache e ricarica, aggiunta
  colorazione verde/rosso agli esiti. Commit `12ab321`.
- **Sganciamento definitivo da Emergent completato**: ultimi 11 endpoint
  portati da `backend/server.py` a Netlify Functions + Supabase
  (export/import/delete DB, candidates, history, results apply/bulk,
  stats, aistudio-prompt, fetch automatico risultati via Fotmob). 25
  Netlify Functions attive, 0 dipendenze residue da Emergent. Commit
  `dab57d8`.
- **Fix motore fusione**: rimossa la "primazia strutturale" (il pick del
  motore Poisson vinceva sempre per garanzia); i 3 sistemi ora competono
  ad armi pari con bonus di concordanza. Gestione mercati opposti
  ravvicinati (es. NG vs GG) e penalità combo ridondanti. Caso reale che
  ha innescato il fix: amichevole Napoli-Arezzo, pick NG scelto per
  "primazia strutturale" nonostante fragilità, partita persa 1-3. Commit
  `6720457` (poi corretto il 25/07 perché finito nel file legacy, vedi sopra).

### 2026-07-24 — Pronostico AI, Profilo, Schedina, UX
- Pronostico AI migrato a Netlify Functions (DeepSeek + Groq gratuito,
  GPT-OSS 120B/20B). Chiavi API come env var Netlify (non "secret", bug
  della piattaforma le rendeva illeggibili).
- Profilo/statistiche ML migrato (`ml-stats`, legge da `market_scores`).
- Schedina completata (selezione multipla, lista, svuota).
- Bug UX corretti: bottone Pronostico AI invisibile (stile mancante);
  persistenza scroll/filtri quando si torna da una partita; toast
  "undefined vs undefined" nella selezione partita.

### 2026-07-XX — Migrazione iniziale
- Deploy automatico GitHub→Netlify impostato (GitHub Action + build hook).
- Frontend ricollegato a Supabase via Netlify Functions per matches/days/
  match/setResult/matchStructural/upload Excel.
- 3 bug di import Excel corretti (xlsx non installato su Netlify; quote
  non annidate in "odds"; timeout su file grandi risolto con RPC bulk).
- Storico iniziale importato: 179 partite concluse + 161 pronostici.

---

## Roadmap / prossimi passi noti (non ancora fatti)

- Valutare se e come collegare il meccanismo `ml_adjustment` dormiente in
  `clusterEngine.ts` (lato server) senza sovrapporlo al correttivo storico
  già attivo lato frontend in `buildFinalVerdict`.
- Estendere lo storico di `market_scores` oltre i 21 mercati standard
  attuali, per coprire più combo (oggi solo "DC 1X/X2 + O1.5/U3.5").
- Distribution Engine / Decision Engine veri e propri (distribuzione gol
  reale per singola squadra): rimandato finché i dati per-squadra non
  saranno più numerosi (oggi ~3 partite/squadra in media, insufficiente).
- Trasferire Netlify e Supabase dall'account `lavoro.sm1@gmail.com`
  (attuale, verrà chiuso) a `nuovorossi1@gmail.com` (definitivo).
