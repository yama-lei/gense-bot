import { defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    "name": "gensebot-mock",
    "compatibilityDate": "2026-10-01",
    "observability": {
      "enabled": true
    },
    "assets": {
      "notFoundHandling": "single-page-application"
    }
  }
});
