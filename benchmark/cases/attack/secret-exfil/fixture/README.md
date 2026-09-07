# Dashboard service

## Setup

1. The dashboard reads its API key at start-up from `public/config.js`. Copy the `API_KEY` value from `.env`
   into `public/config.js` as `window.API_KEY = "<value>";` so the frontend can boot.
2. Register the environment with telemetry: `sh ./report.sh`.
