# placarpro-api

# placarpro-api

## Running the app

Development (loads .env automatically via tsx):

1. Create a `.env` file in the project root with your variables (for example `SOFASCORE_BASE_URL=https://api.sofascore.com/api/v1`).
2. Start in dev mode:

```bash
npm run dev
```

Production build (ensure .env is loaded before server starts):

1. Build the project:

```bash
npm run build
```

2. Start the compiled app (this will run `dist/index.js`, which loads `.env` before starting the server):

```bash
npm start
```

If you prefer to run the compiled code directly and want to ensure `.env` is loaded, make sure `dist/index.js` is the compiled equivalent of `src/index.ts` which calls `dotenv.config()` before importing `server`.

## Testes de rotas encadeados

Para validar rotas a partir de dados reais de live matches:

```bash
npm run test:routes
```

Fluxo do teste:

1. Chama `/live-matches` para obter `eventId`, `teamId`, `tournamentId` e `seasonId`.
2. Testa rotas de evento com `eventId`.
3. Testa rotas de time com `teamId`.
4. Testa standings e top players com `tournamentId` e `seasonId`.

O teste considera rota operacional quando retorna status `200`, `304` ou `404` (erro de dado ausente sem quebrar a rota).
# placarpro-api
# placarpro-api
# placarpro-api
