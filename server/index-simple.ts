import 'dotenv/config';
import express, { type Request, Response, NextFunction } from "express";
import cookieParser from 'cookie-parser';
import { registerRoutes } from "./routes-simple";
import { setupVite, serveStatic, log } from "./vite";

const app = express();

// Basic middleware
// Disable ETag for API JSON to avoid 304 Not Modified on conditional GETs
app.set('etag', false);
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => {
    if ((req as any).originalUrl === '/api/billing/webhook') {
      (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    }
  }
}));
app.use(express.urlencoded({ extended: false, limit: '10mb' }));
app.use(cookieParser());

// No-cache for API endpoints to always return fresh JSON
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    // Also explicitly remove conditional headers that might yield 304
    delete req.headers['if-none-match'];
    delete req.headers['if-modified-since'];
  }
  next();
});

// Basic logging middleware
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
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  const server = await registerRoutes(app);

  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error('Unhandled error:', {
      error: err.message,
      stack: err.stack,
      path: req.path,
      method: req.method,
    });

    // Don't expose internal errors in production
    const responseMessage = process.env.NODE_ENV === 'production' && status === 500 
      ? 'Internal Server Error' 
      : message;

    res.status(status).json({ 
      error: responseMessage,
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
  });

  // Setup Vite in development
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const port = parseInt(process.env.PORT || '5000', 10);
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    console.log(`🚀 Server started successfully on port ${port}`);
    console.log(`📱 Open your browser to: http://localhost:${port}`);
    console.log(`🎙️ Enhanced Voice Cloning Wizard is ready!`);
  });
})();
