import { storyWorker } from "../../server/workers/storyWorker";
import { logger } from "../../server/utils/logger";

logger.info("Story worker starting...");

const close = async () => {
  logger.info("Story worker shutting down...");
  await storyWorker.close();
  process.exit(0);
};

process.on("SIGINT", close);
process.on("SIGTERM", close);
