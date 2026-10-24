import "dotenv/config";
import { createReportApp } from "./src/web/report-app.js";
import { ensureWebEnvVars } from "./src/config/env.js";

ensureWebEnvVars();

const port = process.env.PORT || 3000;
createReportApp().listen(port, () => console.log(`Webserver running on port ${port}`));
