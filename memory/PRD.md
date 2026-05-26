# ScoreBlast - PRD

## Overview
ScoreBlast è un'app mobile React Native Expo per l'analisi di quote calcistiche importate da file Excel. L'app usa Claude Sonnet 4.5 (via Emergent LLM Key) per generare pronostici basati sulla distribuzione delle quote.

## Core Features

### 1. Excel Parser (Backend)
- Legge colonne: A=Ora, B=Manif., E=Sq1, F=Sq2, I=1, J=X, K=2, P=1X, Q=X2, R=12, S=U1.5, T=O1.5, U=U2.5, V=O2.5, W=U3.5, X=O3.5, Y=GG, Z=NG
- Esclude: C, D, G, H, L, M, N, O
- Rileva primo giorno dal header italiano (es. "12 maggio") via regex
- Day-rollover: quando l'ora torna indietro (es. 20:45 → 10:00) incrementa il giorno
- Scarta partite con quote richieste mancanti (1, X, 2, U2.5, O2.5, GG, NG)
- Chiave univoca per partita: (squadra1, squadra2, day)
- Re-upload incrementale: overwrite solo se le quote cambiano

### 2. Stima Quote Mancanti (con suffisso "(stima)")
- 1X = (1·X)/(1+X), X2 = (X·2)/(X+2), 12 = (1·2)/(1+2)
- U_n = 1/(1 - 1/O_n) (complementare)
- O1.5 e O3.5 stimati da O2.5 via Poisson (binary search su λ)

### 3. AI Prediction (Claude Sonnet 4.5)
- System prompt che codifica l'analisi logaritmica/esponenziale del gap U/O
- Output JSON: family (OFFENSIVA_PULITA, RANGE_CONTROLLATO, etc.), analysis, playable_markets (ordinati per probabilità), main_prediction, confidence, min_goals, max_goals
- Cache su MongoDB; invalidata se le quote cambiano

### 4. Schermate Frontend
- **Home** (`/`): lista partite raggruppate per manifestazione, filtro giorno, ricerca, badge AI/cluster, multi-select via checkbox
- **Match Detail** (`/match/[id]`): hero partita, blocco AI con pronostico principale + mercati ordinati, quote per famiglia (Esito Finale, Doppia Chance, U/O 1.5/2.5/3.5, GG/NG), input risultato
- **Strumenti** (`/strumenti`): upload Excel, import/export backup JSON, link a Book e AI Studio Framework, svuota DB
- **Book** (`/book`): regole accordion per ogni mercato (1, 2, 1X, X2, O1.5, U3.5, O2.5, GG, MG 2-4 totali/casa/ospite), bottone "Apri Framework su AI Studio"
- **Selected** (`/selected`): partite selezionate, input risultato per ognuna, salvataggio globale

### 5. Backup/Import/Export
- GET /api/export: JSON con matches + predictions
- POST /api/import: incrementale (skip duplicates)
- Trasferibile tra account

### 6. Google AI Studio Framework
- Bottone genera CSV partite (selezionate) + framework prompt PARTITA_WEB / PARTITA_LLM
- Copia su clipboard (web) e apre aistudio.google.com

## Tech Stack
- Backend: FastAPI + MongoDB + emergentintegrations (Claude Sonnet 4.5) + pandas/openpyxl
- Frontend: Expo Router, React Native, expo-linear-gradient, expo-document-picker, expo-sharing
- Storage: MongoDB (collections: matches, predictions)

## API Endpoints
- POST `/api/upload-excel` - Upload Excel file
- GET `/api/matches?day=&q=` - List matches with filters
- GET `/api/matches/days` - Available days
- GET `/api/matches/{id}` - Match detail + prediction
- POST `/api/matches/{id}/predict` - Generate AI prediction
- POST `/api/matches/{id}/result` - Save result
- POST `/api/results/bulk` - Save multiple results
- POST `/api/matches/selection` - Update selection
- GET `/api/matches/selected/list` - Selected matches
- POST `/api/selection/clear` - Clear all selections
- GET `/api/export` - Export DB
- POST `/api/import` - Import DB
- DELETE `/api/matches/all` - Wipe all
- GET `/api/aistudio/prompt` - Generate AI Studio CSV

## Status: MVP COMPLETE
