import "dotenv/config";
import { createReportApp } from "./src/web/report-app.js";

const required = ["GITHUB_TOKEN", "REPO_DEV", "REPO_DATA_REPORT"];
const missing = required.filter(name => !process.env[name]?.trim());
if (missing.length) {
  throw new Error(`Missing required environment variables for webserver: ${missing.join(", ")}`);
}

const port = process.env.PORT || 3000;
createReportApp().listen(port, () => console.log(`Webserver running on port ${port}`));
