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
# placarpro-api
# placarpro-api
# placarpro-api
