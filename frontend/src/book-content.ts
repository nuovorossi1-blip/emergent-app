export const BOOK_RULES: { market: string; title: string; rules: string[] }[] = [
  {
    market: "1",
    title: "Vittoria Casa (1)",
    rules: [
      "Quota 1 < 1.50: forte favorita, giocabile come singola.",
      "Quota 1 tra 1.50 e 1.85: favorita ma con rischio, valutare la 1X come copertura.",
      "Quota 1 > 1.85: book non ha preferenza chiara, NON giocabile da sola.",
      "Verificare che X non sia troppo bassa (<3.00 indica equilibrio).",
    ],
  },
  {
    market: "2",
    title: "Vittoria Ospite (2)",
    rules: [
      "Quota 2 < 1.50: ospite nettamente favorita.",
      "Quota 2 tra 1.50 e 1.85: favorita ma rischiosa, considera X2.",
      "Quota 2 > 1.85: nessuna preferenza, scarta.",
      "Attenzione al fattore campo: la ospite deve dominare anche statistiche xG.",
    ],
  },
  {
    market: "1X",
    title: "Doppia Chance 1X",
    rules: [
      "Giocabile quando 1 è tra 1.85 e 2.40 e X non supera 3.30.",
      "Quota 1X ideale tra 1.18 e 1.40.",
      "Coprire le squadre forti in casa con qualche dubbio sull'attacco.",
    ],
  },
  {
    market: "X2",
    title: "Doppia Chance X2",
    rules: [
      "Quota 2 tra 1.85 e 2.50 con squadra ospite competitiva.",
      "Quota X2 ideale tra 1.18 e 1.45.",
      "Utile contro favoriti che spesso pareggiano.",
    ],
  },
  {
    market: "Over 1.5",
    title: "Over 1.5 (almeno 2 gol)",
    rules: [
      "Confronto U1.5 vs U2.5: se differenza è logaritmica inversa (gap enorme), pavimento minimo 2 gol.",
      "Quota O1.5 ideale 1.20-1.45.",
      "Verificare che entrambe le squadre abbiano media gol > 1.2.",
    ],
  },
  {
    market: "Under 3.5",
    title: "Under 3.5 (max 3 gol)",
    rules: [
      "Distribuzione O2.5 vs O3.5 esponenziale = tetto massimo 3 gol.",
      "Quota U3.5 ideale 1.10-1.30.",
      "Difese solide o partite tattiche di alta posta.",
    ],
  },
  {
    market: "Over 2.5",
    title: "Over 2.5 (almeno 3 gol)",
    rules: [
      "Quota O2.5 < 1.75 con distribuzione gol lineare.",
      "Entrambe le squadre con xG > 1.4.",
      "Evitare se O2.5 > 2.10 (mercato sporco).",
    ],
  },
  {
    market: "GG",
    title: "Goal/Goal (entrambe segnano)",
    rules: [
      "Giocabile quando GG < 1.65 e c'è chiara propensione offensiva.",
      "Se GG e NG sono vicine (1.80 vs 1.85), distribuzione gol incerta: NON giocabile.",
      "Una difesa debole + un attacco forte da ogni lato.",
    ],
  },
  {
    market: "MG 2-4 Totali",
    title: "Multigoal 2-4 (totali)",
    rules: [
      "Ideale quando pavimento minimo è 2 e tetto massimo è 4.",
      "Distribuzione U1.5 alta + O3.5 alta = corridoio sicuro.",
      "Alternativa a O1.5 quando si vuole limitare tetto.",
    ],
  },
  {
    market: "MG 2-4 Casa",
    title: "Multigoal 2-4 Casa",
    rules: [
      "Squadra casa con attacco produttivo ma non strabordante.",
      "Quote 1 favorita ma non sotto 1.40.",
      "Verificare clean sheet bassi.",
    ],
  },
  {
    market: "MG 2-4 Ospite",
    title: "Multigoal 2-4 Ospite",
    rules: [
      "Squadra ospite con buona produzione offensiva trasferta.",
      "Quote 2 favorita ma con tetto goal.",
      "Difese casa non impenetrabili.",
    ],
  },
];

export const AISTUDIO_FRAMEWORK = `Ruolo: raccoglitore dati web per analisi scommesse calcio.

OBIETTIVO:
- Analizzare le partite del CSV una alla volta
- Usare SOLO questi siti:
  1. fotmob.com
  2. footystats.org
  3. 365scores.com
  4. soccerment.com
  5. one-versus-one.com
- Per ogni partita raccogliere i dati web e POI, usando solo quei dati raccolti, produrre anche un mini responso strutturato
- Il mini responso deve servire per confrontare i dati esterni col sistema interno
- Non fare EV matematico

REGOLE:
- Lavora in ordine CSV
- Se un dato manca scrivi: (dato non disponibile)
- Non usare siti diversi da quelli autorizzati
- Restituisci SOLO output finale copiabile
- Non scrivere prefazioni, note, commenti o spiegazioni
- Non aggiungere testo prima o dopo il blocco finale
- Ogni campo deve stare su una riga separata
- Non mettere mai Match, Lega, Data e Ora sulla stessa riga
- Non comprimere il formato
- Per ogni partita usa ESATTAMENTE questi due blocchi nello stesso ordine:
  1. PARTITA_WEB
  2. PARTITA_LLM

FORMATO OBBLIGATORIO BLOCCO 1 PER OGNI PARTITA:
PARTITA_WEB
Match: CASA vs OSPITE
Lega: [lega]
Data: [data]
Ora: [ora]
FONTI USATE
- [dominio] - [dati trovati]
DATI RACCOLTI
- xG casa:
- xGA casa:
- xG ospite:
- xGA ospite:
- classifica e punti:
- forma ultimi 5 casa:
- forma ultimi 5 trasferta:
- tiri in porta casa:
- tiri in porta ospite:
- tiri totali casa:
- tiri totali ospite:
- assenze confermate:
- formazione probabile:
- motivazioni:
- H2H ultimi 8:
- stanchezza/coppe/trasferta:
- DNA campionato:
END_PARTITA_WEB

FORMATO OBBLIGATORIO BLOCCO 2 PER OGNI PARTITA:
PARTITA_LLM
Match: CASA vs OSPITE
Famiglia: [OFFENSIVA_PULITA | OFFENSIVA_SPORCA | RANGE_CONTROLLATO | CHIUSA_PROTETTA | DOMINANZA_CON_TETTO | INSTABILE]
Radiografia: [mercato breve] | [motivo sintetico]
Analisi Smart: [famiglia/lettura breve] | [casa/ospite/equilibrio] | [mercato 1] | [mercato 2] | [mercato 3]
Value Bet: [mercato migliore / meno peggio / nessun mercato valutabile]
Scelta Finale: [mercato finale scelto]
Fiducia: [Bassa | Media | Alta]
END_PARTITA_LLM

REGOLA FINALE DI INTERPRETAZIONE:
- Dopo aver raccolto i dati del blocco PARTITA_WEB, ignora il ruolo di semplice raccoglitore e fai una lettura finale sui dati trovati
- Devi comportarti come se stessi componendo una multipla ragionata partita per partita
- Per ogni match scegli un solo mercato finale nel blocco PARTITA_LLM
- Se il match è sporco o senza vero valore, puoi scrivere "nessun mercato valutabile" in Value Bet, ma Scelta Finale deve comunque indicare il mercato che ritieni più coerente

CSV PARTITE:
{{CSV}}`;
