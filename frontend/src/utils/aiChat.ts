/**
 * Destinazioni esterne per l'analisi con un LLM, e prompt relativi.
 *
 * 14/09/2026 — Era Google AI Studio, scritto a mano in TRE file diversi.
 * Rossi usa TypingMind: tenerlo in un posto solo evita che la prossima volta
 * se ne aggiornino due su tre.
 *
 * 19/09/2026 — Le destinazioni sono DUE, quindi i tasti in tutto sono quattro:
 *
 *   Strumenti -> "Multipla via TypingMind (esterna)"          TypingMind  MULTIPLA_ESTERNA_PROMPT
 *   Strumenti -> "Multipla via Battle Agent Arena (esterna)"  Arena       MULTIPLA_ESTERNA_PROMPT
 *   Schedina  -> "TYPINGMIND"                                 TypingMind  prompt del server (/aistudio-prompt)
 *   Schedina  -> "BATTLE ARENA"                               Arena       prompt del server (/aistudio-prompt)
 *
 * I due di Strumenti NON partono dalla Schedina: e' il modello a cercare da
 * solo le partite del giorno sul web. I due della Schedina analizzano solo le
 * partite gia' scelte da Rossi. Stesso prompt a coppie, sito diverso.
 *
 * Il prompt non viaggia nell'indirizzo: nessuno dei due siti ha un parametro
 * documentato per precompilare il testo. Resta il meccanismo che gia'
 * funzionava — testo negli appunti, scheda aperta, incolla — che non dipende
 * da come quei siti leggono gli indirizzi.
 */
export const AI_CHAT_URL = "https://www.typingmind.com/";
export const AI_CHAT_NAME = "TypingMind";

/** Seconda destinazione, aggiunta il 19/09/2026 su richiesta di Rossi. */
export const ARENA_URL = "https://arena.ai/agent";
export const ARENA_NAME = "Battle Agent Arena";

/**
 * Prompt dei due tasti "Multipla ... (esterna)" di Strumenti.
 *
 * Testo scritto da Rossi (versione del 19/09/2026) e usato COSI' COM'E':
 * niente segnaposto, niente aggiunte, niente involucri. La data non viene
 * passata di proposito — il prompt chiede al modello "la data odierna reale",
 * piu' affidabile di una data calcolata dal telefono con il rischio di fusi
 * orari sbagliati.
 *
 * Lezione del 16/09 da non ripetere: non avvolgere MAI questo testo dentro un
 * altro framework. Due consegne diverse nello stesso messaggio e il modello
 * segue la prima.
 */
export const MULTIPLA_ESTERNA_PROMPT = `Analizzare le principali partite di calcio in programma oggi, individuare i pattern suggeriti dalle quote, verificarli con la ricerca web e scegliere i mercati con il miglior rapporto tra probabilità stimata e quota.

Flusso

QUOTE → PATTERN → DATI → CONFERMA → MERCATO → VALORE

Ricerca delle partite

Cerca sul web le principali partite di calcio in programma oggi, usando la data odierna reale.

Segui questa priorità:

1ª divisione → 2ª divisione → 3ª divisione

Non scendere oltre la 3ª divisione.

Dai priorità a:

Serie A

Premier League

Liga

Bundesliga

Ligue 1

Eredivisie

Primeira Liga

Champions League

Europa League

Conference League

principali coppe nazionali

Se un campionato di 1ª divisione non ha partite oggi, passa alla relativa 2ª divisione; se non ci sono nemmeno partite di 2ª divisione, passa alla 3ª divisione.

Esempio: Serie A → Serie B → Serie C

Lettura delle quote

Per ogni partita analizza, quando disponibili:

1X2

GG

Over 2,5

Under 3,5

GG + Over 2,5

eventuali altri mercati utili

Le quote servono per individuare uno o più pattern, non per determinare automaticamente il pronostico.

Pattern principali

Pattern quote

Dati da verificare

1 favorito

forza casa, forma e rendimento in casa

2 favorito

forza ospite, forma e rendimento in trasferta

GG

gol fatti/subiti e frequenza GG

Over 2,5

media gol e frequenza Over 2,5

GG + Over 2,5

entrambe segnano + almeno 3 gol

GG + Under 3,5

entrambe segnano ma partita non troppo larga

Casa + GG

vittoria casa + capacità ospite di segnare

Casa + Over

forza offensiva casa + vulnerabilità ospite

Casa + GG + Over

conferma di tutti e tre i segnali

Nessun pattern chiaro

non forzare il pronostico

Il pattern delle quote è un punto di partenza, non una conclusione.

Ricerca e verifica dei dati

Dopo aver individuato il pattern, verifica con la ricerca web:

Squadra di casa

ultime 5 partite

gol fatti nelle ultime 5

gol subiti nelle ultime 5

rendimento nelle partite casalinghe

xG, se disponibile

Squadra ospite

ultime 5 partite

gol fatti nelle ultime 5

gol subiti nelle ultime 5

rendimento nelle partite in trasferta

xG, se disponibile

Altri fattori

formazioni/probabili formazioni

assenze

attaccanti disponibili

difensori assenti

stato di forma

eventuale calendario ravvicinato/fatica

Confronta il pattern individuato dalle quote con i dati.

Se i dati confermano il pattern → considera i mercati collegati al pattern.

Se i dati smentiscono il pattern → riduci la fiducia o cambia pattern/mercato.

Non forzare un pronostico solo perché la quota suggerisce una determinata direzione.

Confronto dei mercati

Quando più mercati sono compatibili con lo stesso scenario, confrontali.

Esempio:

1

GG

Over 2,5

GG + Over 2,5

Scegli il mercato con il miglior rapporto tra:

probabilità stimata + quota + rischio

Non scegliere automaticamente la quota più alta.

Una quota bassa non significa automaticamente che il pronostico sia migliore.

Regola quota minima

Se il pronostico secondo te è corretto, ma la quota del mercato scelto è inferiore a 1,35 (non ha valore rispetto al rischio):

cambia pattern di mercato della stessa partita;

se non ci sono altri pattern compatibili, cambia partita;

mostra comunque, come nota, il pronostico originale che avresti scelto anche se la quota era inferiore a 1,35.

Selezione finale

Tra le partite disponibili seleziona 5-8 partite per costruire una sola multipla.

Per ogni partita scelta indica:

Partita | Pronostico | Quota + bookmaker | Motivazione breve

Spiega anche:

"Tra le principali partite di oggi ho scelto queste perché..."

Multipla

Crea UNA sola multipla:

5-8 eventi

un solo pronostico per partita

quota totale minima 13

fermati appena la quota totale supera 13

Usa informazioni, statistiche e quote aggiornate prima della selezione.

Lingua

Rispondi sempre in italiano.`;

/** Nome storico della costante, tenuto come alias. */
export const AI_MULTIPLA_PROMPT = MULTIPLA_ESTERNA_PROMPT;
