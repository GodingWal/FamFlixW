import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { config } from "./config";
import { logger } from "./utils/logger";
import { 
  securityHeaders, 
  corsConfig, 
  secureCookieParser, 
  sanitizeRequest 
} from "./middleware/security";

const app = express();

// Disable ETag so JSON responses are not turned into 304 Not Modified by Express freshness checks
app.set('etag', false);

// Security middleware
app.use(securityHeaders);
app.use(corsConfig);
app.use(secureCookieParser);

// Body parsing
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => {
    if ((req as Request).originalUrl === '/api/billing/webhook') {
      (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    }
  }
}));
app.use(express.urlencoded({ extended: false, limit: '10mb' }));

// Request sanitization
app.use(sanitizeRequest);

// No-cache for API JSON responses; also strip conditional headers that would trigger 304
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    delete req.headers['if-none-match'];
    delete req.headers['if-modified-since'];
  }
  next();
});

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      logger.logRequest(req.method, path, res.statusCode, duration, {
        userAgent: req.get('User-Agent'),
        ip: req.ip,
        responseData: capturedJsonResponse
      });
    }
  });

  next();
});

(async () => {
  const server = await registerRoutes(app);

  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    logger.error('Unhandled error', {
      error: err.message,
      stack: err.stack,
      path: req.path,
      method: req.method,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
    });

    // Don't expose internal errors in production
    const responseMessage = config.NODE_ENV === 'production' && status === 500 
      ? 'Internal Server Error' 
      : message;

    res.status(status).json({ 
      error: responseMessage,
      ...(config.NODE_ENV === 'development' && { stack: err.stack })
    });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = config.PORT;
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    logger.info(`Server started successfully`, {
      port,
      nodeEnv: config.NODE_ENV,
      timestamp: new Date().toISOString()
    });
  });
})();
