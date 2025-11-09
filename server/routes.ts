import type { Express } from "express";
import express from "express";
import { createServer, type Server } from "http";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import multer from "multer";
import path from "path";
import { z } from "zod";
import { storage } from "./storage";
import { 
  authenticateToken, 
  generateAccessToken, 
  generateRefreshToken, 
  refreshTokens,
  requireRole, 
  AuthRequest 
} from "./middleware/auth-simple";
import {
  apiRateLimit,
  authRateLimit,
  uploadRateLimit,
  validateCSRFToken,
  generateCSRFToken,
  getCSRFTokenSignature,
  CSRF_SIGNATURE_COOKIE,
} from "./middleware/security";
import { generalRateLimit } from "./middleware/rateLimiter";

// Create alias for AI rate limiting
const aiRateLimit = apiRateLimit;
import { healthService } from "./services/healthService-simple";
import { metricsService } from "./services/metricsService-simple";
import { logger } from "./utils/logger-simple";
import { config } from "./config";
import { voiceService } from "./services/voiceService";
import { videoService } from "./services/videoService";
import { collaborationService } from "./services/collaborationService";
import { voiceJobService } from "./services/voiceJobService";
import { emailService } from "./services/emailService";
import { storyService } from "./services/storyService";
import storiesRouter from "./routes/stories";
import storiesAdminRouter from "./routes/stories-admin";
import {
  insertUserSchema,
  insertFamilySchema,
  insertVideoSchema,
  insertVoiceProfileSchema,
  subscriptionPlans,
  type SubscriptionPlan,
  type User,
  type InsertAdPreference,
} from "@shared/schema-sqlite";
import { billingService } from "./services/billingService";

// Multer configuration for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
});

// Validation schemas
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const registerSchema = insertUserSchema.extend({
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

const verifyEmailSchema = z.object({
  token: z.string().min(1, "Token is required"),
});

const resendVerificationSchema = z.object({
  email: z.string().email(),
});

const passwordResetRequestSchema = z.object({
  email: z.string().email(),
});

const passwordResetSchema = z
  .object({
    token: z.string().min(1, "Token is required"),
    password: z.string().min(6, "Password must be at least 6 characters"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  });

const storyGenerationSchema = z.object({
  storyId: z.string().optional(),
  familyId: z.string().optional(),
  category: z.string().optional(),
  title: z.string().optional(),
  generateNarrations: z.boolean().optional(),
  voiceProfileId: z.string().optional(),
});

const storyNarrationSchema = z.object({
  voiceProfileId: z.string().min(1, "voiceProfileId is required"),
});

const checkoutSchema = z.object({
  plan: z.enum(subscriptionPlans).refine((plan) => plan !== "free", {
    message: "Select a paid plan to upgrade.",
  }),
});

// Marketing lead submission
const marketingLeadSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Valid email is required"),
  familySize: z.number().int().min(0).default(0),
  message: z.string().max(5000).default(""),
});

// Ads preferences
const DEFAULT_AD_DAILY_CAP = 5;
const adPreferenceQuerySchema = z.object({
  placementId: z.string().min(1, "placementId is required"),
});

const adPreferenceUpdateSchema = z.object({
  placementId: z.string().min(1, "placementId is required"),
  optOut: z.boolean().optional(),
  incrementImpression: z.boolean().optional(),
  dailyCap: z.number().int().min(1).max(50).optional(),
});

const serializeUser = (user: User) => ({
  id: user.id,
  email: user.email,
  username: user.username,
  firstName: user.firstName,
  lastName: user.lastName,
  avatar: user.avatar,
  role: user.role,
  plan: user.plan,
  planRenewalAt: user.planRenewalAt ? user.planRenewalAt.toISOString() : null,
});

export async function registerRoutes(app: Express): Promise<Server> {
  // Apply API rate limiting
  app.use('/api', apiRateLimit);
  if (config.FEATURE_STORY_MODE) {
    app.use(storiesRouter);
    app.use(storiesAdminRouter);
  }

  const parsePlacementId = (value: unknown) => {
    if (Array.isArray(value)) {
      return typeof value[0] === 'string' ? value[0] : undefined;
    }

    return typeof value === 'string' ? value : undefined;
  };

  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const ensureAdPreferenceWindow = async (userId: string, placementId: string) => {
    const preference = await storage.getAdPreference(userId, placementId);

    if (preference?.lastImpressionAt) {
      const lastImpression = new Date(preference.lastImpressionAt);
      if (!isSameDay(new Date(), lastImpression)) {
        return storage.upsertAdPreference(userId, placementId, {
          dailyImpressions: 0,
          lastImpressionAt: null,
        });
      }
    }

    return preference ?? undefined;
  };

  const userHasFamilyAccess = async (familyId: string, userId: string) => {
    const family = await storage.getFamily(familyId);
    if (!family) {
      return false;
    }

    if (family.ownerId === userId) {
      return true;
    }

    const members = await storage.getFamilyMembers(familyId);
    return members.some(member => member.id === userId);
  };

  const userCanAccessStory = async (storyId: string, userId: string) => {
    const story = await storage.getStory(storyId);
    if (!story) {
      return { allowed: false, story: undefined };
    }

    if (story.createdBy === userId) {
      return { allowed: true, story };
    }

    if (story.familyId) {
      const allowed = await userHasFamilyAccess(story.familyId, userId);
      return { allowed, story };
    }

    return { allowed: false, story };
  };

  // Health check endpoints
  app.get('/api/health', async (req, res) => {
    try {
      const health = await healthService.getSimpleHealth();
      res.status(health.status === 'ok' ? 200 : 503).json(health);
    } catch (error) {
      logger.error('Health check failed:', error);
      res.status(503).json({ 
        status: 'error', 
        timestamp: new Date().toISOString() 
      });
    }
  });

  app.get('/api/health/detailed', authenticateToken, requireRole(['admin']), async (req, res) => {
    try {
      const health = await healthService.getSystemHealth();
      res.json(health);
    } catch (error) {
      logger.error('Detailed health check failed:', error);
      res.status(500).json({ error: 'Health check failed' });
    }
  });

  // Metrics endpoint
  app.get('/api/metrics', authenticateToken, requireRole(['admin']), (req, res) => {
    try {
      const metrics = metricsService.getMetricsSummary();
      res.json(metrics);
    } catch (error) {
      logger.error('Metrics retrieval failed:', error);
      res.status(500).json({ error: 'Failed to retrieve metrics' });
    }
  });

  // CSRF token endpoint
  app.get('/api/csrf-token', (req, res) => {
    const token = generateCSRFToken();
    const signature = getCSRFTokenSignature(token);

    res.cookie(CSRF_SIGNATURE_COOKIE, signature, {
      httpOnly: true,
      secure: config.COOKIE_SECURE,
      sameSite: config.COOKIE_SAME_SITE,
      maxAge: 2 * 60 * 60 * 1000, // 2 hours
    });

    res.json({ csrfToken: token });
  });

  app.post('/api/marketing/leads', generalRateLimit, async (req, res) => {
    try {
      const payload = marketingLeadSchema.parse(req.body);

      try {
        await storage.createMarketingLead(payload);
      } catch (error) {
        logger.warn('Failed to persist marketing lead', { error });
      }

      try {
        await emailService.sendMarketingLeadNotification(payload);
      } catch (error) {
        logger.error('Failed to forward marketing lead via email', { error });
        return res.status(500).json({ error: 'Unable to forward marketing lead' });
      }

      res.status(201).json({
        message: 'Thanks for reaching out! A member of the FamFlix team will be in touch soon.',
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: 'Invalid marketing lead details',
          details: error.flatten(),
        });
      }

      logger.error('Failed to process marketing lead submission', { error });
      res.status(500).json({ error: 'Failed to submit marketing lead' });
    }
  });

  // Auth routes
  app.post('/api/auth/register', authRateLimit, async (req, res) => {
    try {
      const validatedData = registerSchema.parse(req.body);
      const { confirmPassword, plan: _requestedPlan, ...userData } = validatedData;

      // Check if user already exists
      const existingUser = await storage.getUserByEmail(userData.email);
      if (existingUser) {
        return res.status(400).json({ error: "User already exists" });
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(userData.password, 12);
      
      // Create user
      const user = await storage.createUser({
        ...userData,
        password: hashedPassword,
        plan: "free",
        planRenewalAt: null,
      });

      let requiresEmailVerification = true;

      if (!emailService.isEnabled()) {
        await storage.markUserEmailVerified(user.id);
        requiresEmailVerification = false;
        logger.info('User registered successfully (auto-verified)', { userId: user.id, email: user.email });
      } else {
        const verificationToken = crypto.randomBytes(48).toString("hex");
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

        await storage.createEmailVerificationToken({
          userId: user.id,
          token: verificationToken,
          expiresAt,
        });

        await emailService.sendVerificationEmail({
          to: user.email,
          token: verificationToken,
          username: user.firstName ?? user.username,
        });

        logger.info('User registered successfully', { userId: user.id, email: user.email });
      }
      metricsService.recordMetric({
        name: 'user_registrations_total',
        value: 1,
        unit: 'count'
      });

      res.status(201).json({
        message: requiresEmailVerification
          ? "User created successfully. Please verify your email to activate your account."
          : "User created successfully.",
        requiresEmailVerification,
      });
    } catch (error: any) {
      logger.error('Registration error:', { error: error.message, email: req.body?.email });
      metricsService.recordError({
        type: 'registration_error',
        message: error.message,
        path: '/api/auth/register'
      });
      res.status(400).json({ error: error.message || "Registration failed" });
    }
  });

  app.post('/api/auth/verify-email', authRateLimit, async (req, res) => {
    try {
      const { token } = verifyEmailSchema.parse(req.body);

      const tokenRecord = await storage.getEmailVerificationToken(token);
      if (!tokenRecord) {
        return res.status(400).json({ error: "Invalid or expired verification token" });
      }

      if (tokenRecord.expiresAt < new Date()) {
        await storage.deleteEmailVerificationToken(token);
        return res.status(400).json({ error: "Verification token has expired" });
      }

      const user = await storage.getUser(tokenRecord.userId);
      if (!user) {
        await storage.deleteEmailVerificationToken(token);
        return res.status(404).json({ error: "User not found" });
      }

      if (!user.isEmailVerified) {
        await storage.markUserEmailVerified(user.id);
        logger.info('User email verified', { userId: user.id, email: user.email });
      }

      await storage.deleteEmailVerificationTokensForUser(user.id);

      res.json({ message: "Email verified successfully" });
    } catch (error: any) {
      logger.error('Email verification error:', { error: error.message });
      res.status(400).json({ error: error.message || "Email verification failed" });
    }
  });

  app.post('/api/auth/resend-verification', authRateLimit, async (req, res) => {
    try {
      const { email } = resendVerificationSchema.parse(req.body);
      const user = await storage.getUserByEmail(email);

      if (!user) {
        return res.json({
          message: "If an account exists with that email, a verification message has been sent.",
        });
      }

      if (user.isEmailVerified) {
        return res.json({ message: "Email is already verified." });
      }

      const verificationToken = crypto.randomBytes(48).toString("hex");
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await storage.createEmailVerificationToken({
        userId: user.id,
        token: verificationToken,
        expiresAt,
      });

      await emailService.sendVerificationEmail({
        to: user.email,
        token: verificationToken,
        username: user.firstName ?? user.username,
      });

      logger.info('Verification email resent', { userId: user.id, email: user.email });

      res.json({
        message: "If an account exists with that email, a verification message has been sent.",
      });
    } catch (error: any) {
      logger.error('Resend verification error:', { error: error.message, email: req.body?.email });
      res.status(400).json({ error: error.message || "Failed to resend verification" });
    }
  });

  app.post('/api/auth/request-password-reset', authRateLimit, async (req, res) => {
    try {
      const { email } = passwordResetRequestSchema.parse(req.body);
      const user = await storage.getUserByEmail(email);

      if (user) {
        const resetToken = crypto.randomBytes(48).toString("hex");
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        await storage.createPasswordResetToken({
          userId: user.id,
          token: resetToken,
          expiresAt,
        });

        await emailService.sendPasswordResetEmail({
          to: user.email,
          token: resetToken,
          username: user.firstName ?? user.username,
        });

        logger.info('Password reset requested', { userId: user.id, email: user.email });
      }

      res.json({
        message: "If an account exists with that email, you will receive reset instructions shortly.",
      });
    } catch (error: any) {
      logger.error('Password reset request error:', { error: error.message, email: req.body?.email });
      res.status(400).json({ error: error.message || "Failed to request password reset" });
    }
  });

  app.post('/api/auth/reset-password', authRateLimit, async (req, res) => {
    try {
      const { token, password } = passwordResetSchema.parse(req.body);

      const tokenRecord = await storage.getPasswordResetToken(token);
      if (!tokenRecord) {
        return res.status(400).json({ error: "Invalid or expired reset token" });
      }

      if (tokenRecord.expiresAt < new Date()) {
        await storage.deletePasswordResetToken(token);
        return res.status(400).json({ error: "Reset token has expired" });
      }

      const user = await storage.getUser(tokenRecord.userId);
      if (!user) {
        await storage.deletePasswordResetToken(token);
        return res.status(404).json({ error: "User not found" });
      }

      const hashedPassword = await bcrypt.hash(password, 12);
      await storage.updateUser(user.id, { password: hashedPassword });
      await storage.deletePasswordResetTokensForUser(user.id);

      logger.info('Password reset successful', { userId: user.id, email: user.email });

      res.json({ message: "Password reset successfully" });
    } catch (error: any) {
      logger.error('Password reset error:', { error: error.message });
      res.status(400).json({ error: error.message || "Failed to reset password" });
    }
  });

  app.post('/api/auth/login', authRateLimit, async (req, res) => {
    try {
      const { email, password } = loginSchema.parse(req.body);

      // Find user
      const user = await storage.getUserByEmail(email);
      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      // Check password
      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      if (!user.isEmailVerified) {
        if (!emailService.isEnabled()) {
          await storage.markUserEmailVerified(user.id);
          user.isEmailVerified = true;
        } else {
          return res.status(403).json({
            error: "Please verify your email before signing in.",
            needsVerification: true,
          });
        }
      }

      // Check if user is active
      if (!user.isActive) {
        return res.status(401).json({ error: "Account is deactivated" });
      }

      // Generate tokens
      const accessToken = generateAccessToken(user.id);
      const refreshToken = generateRefreshToken(user.id);

      // Set httpOnly cookies
      res.cookie('accessToken', accessToken, {
        httpOnly: true,
        secure: config.COOKIE_SECURE,
        sameSite: config.COOKIE_SAME_SITE,
        maxAge: 15 * 60 * 1000, // 15 minutes
      });

      res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: config.COOKIE_SECURE,
        sameSite: config.COOKIE_SAME_SITE,
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      });

      logger.info('User login successful', { userId: user.id, email: user.email });
      metricsService.recordMetric({
        name: 'user_logins_total',
        value: 1,
        unit: 'count'
      });

      res.json({
        message: "Login successful",
        accessToken, // Also return for clients that need it
        user: serializeUser(user),
      });
    } catch (error: any) {
      logger.error('Login error:', { error: error.message, email: req.body?.email });
      metricsService.recordError({
        type: 'login_error',
        message: error.message,
        path: '/api/auth/login'
      });
      res.status(400).json({ error: error.message || "Login failed" });
    }
  });

  // Token refresh endpoint
  app.post('/api/auth/refresh', refreshTokens);

  // Logout endpoint
  app.post('/api/auth/logout', (req, res) => {
    // Clear cookies
    res.clearCookie('accessToken');
    res.clearCookie('refreshToken');

    logger.info('User logout', { ip: req.ip });
    res.json({ message: 'Logout successful' });
  });

  app.post('/api/billing/checkout', authenticateToken, async (req: AuthRequest, res) => {
    if (!billingService.isConfigured()) {
      return res.status(503).json({ error: "Billing is currently unavailable" });
    }

    try {
      const { plan } = checkoutSchema.parse(req.body);
      const user = await storage.getUser(req.user!.id);

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      if (user.plan === plan) {
        return res.status(400).json({ error: "You are already subscribed to this plan." });
      }

      const session = await billingService.createCheckoutSession(
        { id: user.id, email: user.email },
        plan as SubscriptionPlan,
      );

      res.json({ sessionId: session.id });
    } catch (error: any) {
      logger.error('Checkout session creation failed', {
        error: error.message,
        userId: req.user?.id,
      });
      res.status(400).json({ error: error.message || "Unable to start checkout" });
    }
  });

  app.post('/api/billing/webhook', async (req, res) => {
    if (!billingService.isConfigured()) {
      return res.json({ received: true });
    }

    const signatureHeader = req.headers["stripe-signature"];
    if (!signatureHeader || Array.isArray(signatureHeader)) {
      return res.status(400).send("Webhook Error: Missing Stripe signature");
    }

    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      return res.status(400).send("Webhook Error: Missing raw request body");
    }

    try {
      const event = billingService.constructEvent(rawBody, signatureHeader);
      await billingService.handleWebhookEvent(event);
      res.json({ received: true });
    } catch (error: any) {
      logger.error('Stripe webhook processing error', { error: error.message });
      res.status(400).send(`Webhook Error: ${error.message || 'Unknown error'}`);
    }
  });

  app.get('/api/auth/me', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const user = await storage.getUser(req.user!.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json(serializeUser(user));
    } catch (error) {
      console.error('Get user error:', error);
      res.status(500).json({ error: "Failed to get user data" });
    }
  });

  app.get('/api/ads/preferences', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const placementIdValue = parsePlacementId(req.query.placementId);
      const { placementId } = adPreferenceQuerySchema.parse({
        placementId: placementIdValue ?? "",
      });

      const preference = await ensureAdPreferenceWindow(req.user!.id, placementId);
      const dailyCap = preference?.dailyCap ?? DEFAULT_AD_DAILY_CAP;
      const dailyImpressions = preference?.dailyImpressions ?? 0;
      const lastImpressionAt = preference?.lastImpressionAt
        ? new Date(preference.lastImpressionAt).toISOString()
        : null;

      res.json({
        placementId,
        optOut: preference?.optOut ?? false,
        dailyCap,
        dailyImpressions,
        lastImpressionAt,
        frequencyCapReached: dailyImpressions >= dailyCap,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues[0]?.message ?? 'Invalid ad preference request' });
      }

      logger.error('Failed to load ad preferences', error);
      res.status(500).json({ error: 'Unable to load ad preferences' });
    }
  });

  app.post('/api/ads/preferences', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const { placementId, optOut, incrementImpression = false, dailyCap } = adPreferenceUpdateSchema.parse(req.body);
      const userId = req.user!.id;

      let preference = await ensureAdPreferenceWindow(userId, placementId);
      const effectiveDailyCap = dailyCap ?? preference?.dailyCap ?? DEFAULT_AD_DAILY_CAP;

      const updates: Partial<Omit<InsertAdPreference, "userId" | "placementId">> = {};

      if (optOut !== undefined) {
        updates.optOut = optOut;
      }

      if (dailyCap !== undefined) {
        updates.dailyCap = dailyCap;
      }

      if (incrementImpression) {
        const impressions = preference?.dailyImpressions ?? 0;
        if (impressions >= effectiveDailyCap) {
          return res.status(200).json({
            placementId,
            optOut: preference?.optOut ?? false,
            dailyCap: effectiveDailyCap,
            dailyImpressions: impressions,
            lastImpressionAt: preference?.lastImpressionAt
              ? new Date(preference.lastImpressionAt).toISOString()
              : null,
            frequencyCapReached: true,
          });
        }

        updates.dailyImpressions = impressions + 1;
        updates.lastImpressionAt = new Date();
      }

      if (Object.keys(updates).length === 0) {
        preference = preference ?? await storage.upsertAdPreference(userId, placementId, {});
      } else {
        preference = await storage.upsertAdPreference(userId, placementId, updates);
      }

      const appliedDailyCap = preference?.dailyCap ?? effectiveDailyCap;
      const dailyImpressions = preference?.dailyImpressions ?? 0;
      const lastImpressionAt = preference?.lastImpressionAt
        ? new Date(preference.lastImpressionAt).toISOString()
        : null;

      res.json({
        placementId,
        optOut: preference?.optOut ?? false,
        dailyCap: appliedDailyCap,
        dailyImpressions,
        lastImpressionAt,
        frequencyCapReached: dailyImpressions >= appliedDailyCap,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues[0]?.message ?? 'Invalid ad preference request' });
      }

      logger.error('Failed to update ad preferences', error);
      res.status(500).json({ error: 'Unable to update ad preferences' });
    }
  });

  // Family management routes
  app.post('/api/families', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const familyData = insertFamilySchema.parse({
        ...req.body,
        ownerId: req.user!.id,
      });

      const family = await storage.createFamily(familyData);
      
      res.status(201).json(family);
    } catch (error: any) {
      console.error('Create family error:', error);
      res.status(400).json({ error: error.message || "Failed to create family" });
    }
  });

  app.get('/api/families', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const families = await storage.getFamiliesByUser(req.user!.id);
      res.json(families);
    } catch (error) {
      console.error('Get families error:', error);
      res.status(500).json({ error: "Failed to get families" });
    }
  });

  app.get('/api/families/:familyId/members', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const members = await storage.getFamilyMembers(req.params.familyId);
      res.json(members);
    } catch (error) {
      console.error('Get family members error:', error);
      res.status(500).json({ error: "Failed to get family members" });
    }
  });

  // Video management routes
  
  // Admin-only route to upload video assets
  app.post('/api/admin/videos', authenticateToken, requireRole(['admin']), upload.single('video'), async (req: AuthRequest, res) => {
    try {
      let videoData = insertVideoSchema.parse({
        ...req.body,
        createdBy: req.user!.id,
      });

      // Process video upload if file provided
      if (req.file) {
        const processedVideo = await videoService.processVideoUpload(req.file.buffer, req.body);
        videoData = {
          ...videoData,
          videoUrl: processedVideo.videoUrl,
          thumbnail: processedVideo.thumbnail,
          duration: processedVideo.duration,
          metadata: processedVideo.metadata,
        };
      }

      const video = await storage.createAdminProvidedVideo(videoData);
      res.status(201).json(video);
    } catch (error: any) {
      console.error('Admin create video error:', error);
      res.status(400).json({ error: error.message || "Failed to create admin video" });
    }
  });

  // Get admin-provided videos for users to select from
  app.get('/api/videos/provided', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const videos = await storage.getAdminProvidedVideos();
      res.json(videos);
    } catch (error) {
      console.error('Get provided videos error:', error);
      res.status(500).json({ error: "Failed to get provided videos" });
    }
  });

  // User route to create projects based on provided videos (no file upload)
  app.post('/api/videos', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const videoData = insertVideoSchema.parse({
        ...req.body,
        createdBy: req.user!.id,
      });

      const video = await storage.createUserProject(videoData);
      res.status(201).json(video);
    } catch (error: any) {
      console.error('Create user project error:', error);
      res.status(400).json({ error: error.message || "Failed to create project" });
    }
  });

  app.get('/api/videos', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const { familyId } = req.query;
      
      let videos;
      if (familyId) {
        videos = await videoService.getVideosByFamily(familyId as string);
      } else {
        videos = await videoService.getVideosByUser(req.user!.id);
      }
      
      res.json(videos);
    } catch (error) {
      console.error('Get videos error:', error);
      res.status(500).json({ error: "Failed to get videos" });
    }
  });

  app.get('/api/videos/:videoId', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const video = await storage.getVideo(req.params.videoId);
      if (!video) {
        return res.status(404).json({ error: "Video not found" });
      }
      res.json(video);
    } catch (error) {
      console.error('Get video error:', error);
      res.status(500).json({ error: "Failed to get video" });
    }
  });

  app.put('/api/videos/:videoId', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const updates = req.body;
      const video = await videoService.updateVideo(req.params.videoId, updates, req.user!.id);
      res.json(video);
    } catch (error: any) {
      console.error('Update video error:', error);
      res.status(400).json({ error: error.message || "Failed to update video" });
    }
  });

  app.delete('/api/videos/:videoId', authenticateToken, async (req: AuthRequest, res) => {
    try {
      await videoService.deleteVideo(req.params.videoId, req.user!.id);
      res.json({ message: "Video deleted successfully" });
    } catch (error: any) {
      console.error('Delete video error:', error);
      res.status(400).json({ error: error.message || "Failed to delete video" });
    }
  });

  // AI-powered video suggestions
  app.get('/api/videos/suggestions/:familyId', authenticateToken, aiRateLimit, async (req: AuthRequest, res) => {
    try {
      const suggestions = await videoService.generateVideoSuggestions(req.params.familyId);
      res.json(suggestions);
    } catch (error) {
      console.error('Get video suggestions error:', error);
      res.status(500).json({ error: "Failed to generate video suggestions" });
    }
  });

  // Voice cloning routes
  app.post('/api/voice-profiles', authenticateToken, uploadRateLimit, validateCSRFToken, upload.single('audio'), async (req: AuthRequest, res) => {
    const startTime = Date.now();
    let voiceProfileId: string | null = null;
    
    try {
      console.log(`Voice profile creation started by user ${req.user!.id}`);
      
      if (!req.file) {
        console.log('Voice profile creation failed: No audio file provided');
        return res.status(400).json({ error: "Audio file is required" });
      }

      const { name, familyId } = req.body;
      
      // Validate input
      if (!name || name.trim().length === 0) {
        console.log('Voice profile creation failed: Invalid name');
        return res.status(400).json({ error: "Valid name is required" });
      }
      
      if (name.length > 50) {
        console.log('Voice profile creation failed: Name too long');
        return res.status(400).json({ error: "Name must be 50 characters or less" });
      }
      
      // Validate audio file
      const allowedMimeTypes = ['audio/wav', 'audio/mpeg', 'audio/mp3', 'audio/webm', 'audio/ogg'];
      if (!allowedMimeTypes.includes(req.file.mimetype)) {
        console.log(`Voice profile creation failed: Invalid mime type ${req.file.mimetype}`);
        return res.status(400).json({ error: "Invalid audio format. Please use WAV, MP3, WebM, or OGG" });
      }
      
      if (req.file.size > 10 * 1024 * 1024) { // 10MB limit for audio
        console.log(`Voice profile creation failed: File too large (${req.file.size} bytes)`);
        return res.status(400).json({ error: "Audio file too large. Maximum size is 10MB" });
      }
      
      if (req.file.size < 1024) { // Minimum 1KB
        console.log(`Voice profile creation failed: File too small (${req.file.size} bytes)`);
        return res.status(400).json({ error: "Audio file too small. Please provide a valid recording" });
      }

      // Validate family access if familyId is provided
      if (familyId) {
        const familyMembers = await storage.getFamilyMembers(familyId);
        const familyMember = familyMembers.find(member => member.id === req.user!.id);
        if (!familyMember) {
          console.log(`Voice profile creation failed: User ${req.user!.id} not a member of family ${familyId}`);
          return res.status(403).json({ error: "You don't have access to this family" });
        }
      }

      console.log(`Creating voice clone: ${name.trim()} (${req.file.size} bytes, ${req.file.mimetype})`);
      
      voiceProfileId = await voiceService.createVoiceClone(
        req.file.buffer,
        name.trim(),
        req.user!.id,
        familyId
      );

      const voiceProfile = await storage.getVoiceProfile(voiceProfileId);
      const duration = Date.now() - startTime;
      
      console.log(`Voice profile created successfully: ${voiceProfileId} in ${duration}ms`);
      
      res.status(201).json(voiceProfile);
    } catch (error: any) {
      const duration = Date.now() - startTime;
      console.error(`Voice profile creation failed after ${duration}ms:`, error);

      // Return appropriate error message
      const msg = typeof error.message === 'string' ? error.message : String(error);
      if (msg.toLowerCase().includes('chatterbox')) {
        res.status(503).json({ error: "Voice cloning service error. Please try again later." });
      } else {
        const errorMessage = error instanceof Error ? error.message : "Failed to create voice profile";
        res.status(500).json({ error: errorMessage });
      }
    }
  });

  app.get('/api/voice-profiles', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const { familyId } = req.query;
      
      let profiles;
      if (familyId) {
        profiles = await voiceService.getVoiceProfilesByFamily(familyId as string);
      } else {
        profiles = await voiceService.getVoiceProfilesByUser(req.user!.id);
      }
      
      res.json(profiles);
    } catch (error) {
      console.error('Get voice profiles error:', error);
      res.status(500).json({ error: "Failed to get voice profiles" });
    }
  });

  app.post('/api/voice-profiles/:profileId/generate', authenticateToken, aiRateLimit, async (req: AuthRequest, res) => {
    try {
      const { text } = req.body;
      if (!text) {
        return res.status(400).json({ error: "Text is required" });
      }

      const generationId = await voiceService.generateSpeech(
        req.params.profileId,
        text,
        req.user!.id
      );

      const generation = await storage.getVoiceGeneration(generationId);
      res.status(201).json(generation);
    } catch (error: any) {
      console.error('Generate speech error:', error);
      res.status(400).json({ error: error.message || "Failed to generate speech" });
    }
  });

  app.get('/api/voice-profiles/:profileId/generations', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const user = req.user!;
      
      // Verify profile exists and user has access
      const profile = await storage.getVoiceProfile(req.params.profileId);
      if (!profile) {
        return res.status(404).json({ error: "Voice profile not found" });
      }
      
      // Check if user has access to this profile
      if (profile.userId !== user.id) {
        // Check if user is in the same family
        if (profile.familyId) {
          const family = await storage.getFamily(profile.familyId);
          const familyMembers = await storage.getFamilyMembers(profile.familyId);
          const isFamilyMember = familyMembers?.some((member: any) => member.userId === user.id);
          if (!isFamilyMember) {
            return res.status(403).json({ error: "Access denied" });
          }
        } else {
          return res.status(403).json({ error: "Access denied" });
        }
      }
      
      const generations = await storage.getVoiceGenerationsByProfile(req.params.profileId);
      res.json(generations);
    } catch (error) {
      console.error('Get voice generations error:', error);
      res.status(500).json({ error: "Failed to get voice generations" });
    }
  });

  // Voice preview: short kids story (~20s) + TTS using selected voice
  app.post('/api/voice-profiles/:profileId/preview', authenticateToken, aiRateLimit, async (req: AuthRequest, res) => {
    try {
      const profileId = req.params.profileId;
      const { familyId, targetSeconds = 20 } = req.body ?? {};

      const profile = await storage.getVoiceProfile(profileId);
      if (!profile) {
        return res.status(404).json({ error: "Voice profile not found" });
      }
      if (profile.userId !== req.user!.id) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (profile.status !== 'ready') {
        return res.status(400).json({ error: "Voice profile is not ready yet" });
      }

      const familyContext = familyId ? await storage.getFamily(familyId) : null;
      const { aiService } = await import('./services/aiService');
      const story = await aiService.generateKidsStory(familyContext, { targetSeconds: Number(targetSeconds) || 20 });

      // Attempt TTS, but don't fail the whole preview if TTS is unavailable
      let generation: any = null;
      try {
        const generationId = await voiceService.generateSpeech(profileId, story, req.user!.id);
        generation = await storage.getVoiceGeneration(generationId);
      } catch (ttsError: any) {
        console.error('TTS generation failed for preview:', ttsError?.message || ttsError);
        // Continue with story-only preview
      }

      return res.json({ 
        story, 
        generation, 
        previewSeconds: Number(targetSeconds) || 20,
        ...(generation ? {} : { warning: 'TTS unavailable for preview' })
      });
    } catch (error: any) {
      console.error('Voice preview error:', error);
      res.status(400).json({ error: error.message || 'Failed to generate preview' });
    }
  });
  
  // Serve audio files securely
  app.get('/api/audio/:filename', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const user = req.user!;
      const filename = req.params.filename;

      // Validate filename to prevent path traversal
      if (!/^[a-zA-Z0-9_-]+\.(wav|mp3|webm|ogg)$/.test(filename)) {
        return res.status(400).json({ error: "Invalid filename" });
      }

      // Build path to the audio file
      const path = await import('path');
      const fs = await import('fs');
      const audioFilePath = path.join(process.cwd(), 'temp', filename);

      const audioUrl = `/api/audio/${filename}`;
      let accessGranted = false;

      const voiceGeneration = await storage.getVoiceGenerationByAudioUrl(audioUrl);
      if (voiceGeneration) {
        if (voiceGeneration.requestedBy === user.id) {
          accessGranted = true;
        } else {
          const voiceProfile = await storage.getVoiceProfile(voiceGeneration.voiceProfileId);
          if (voiceProfile) {
            if (voiceProfile.userId === user.id) {
              accessGranted = true;
            } else if (voiceProfile.familyId) {
              accessGranted = await userHasFamilyAccess(voiceProfile.familyId, user.id);
            }
          }
        }
      }

      if (!accessGranted) {
        const narration = await storage.getStoryNarrationByAudioFileName(filename);
        if (narration) {
          const storyCheck = await userCanAccessStory(narration.storyId, user.id);
          if (storyCheck.story && storyCheck.allowed) {
            accessGranted = true;
          }
        }
      }

      if (!accessGranted) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Verify user has access to this audio file
      // TODO: In production, add proper access control checks

      try {
        // Check if file exists
        await fs.promises.access(audioFilePath);
        
        // Set proper headers for audio streaming
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
        
        // Stream the actual audio file
        const fileStream = fs.createReadStream(audioFilePath);
        fileStream.pipe(res);
        
      } catch (fileError) {
        console.error('Audio file not found:', audioFilePath);
        res.status(404).json({ error: "Audio file not found" });
      }
      
    } catch (error) {
      console.error('Audio serving error:', error);
      res.status(500).json({ error: "Failed to serve audio file" });
    }
  });

  app.delete('/api/voice-profiles/:profileId', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const { profileId } = req.params;
      const profile = await storage.getVoiceProfile(profileId);
      if (!profile) {
        return res.status(404).json({ error: 'Voice profile not found' });
      }

      // Only the owner can delete their voice profile
      if (profile.userId !== req.user!.id) {
        return res.status(403).json({ error: 'Access denied' });
      }

      await voiceService.deleteVoiceProfile(profileId);
      res.json({ message: 'Voice profile deleted successfully' });
    } catch (error: any) {
      console.error('Delete voice profile error:', error);
      res.status(400).json({ error: error.message || 'Failed to delete voice profile' });
    }
  });

  // Voice job management routes
  app.post('/api/voice-jobs', authenticateToken, uploadRateLimit, validateCSRFToken, upload.array('recordings'), async (req: AuthRequest, res) => {
    try {
      const { name, familyId } = req.body;
      
      if (!name || name.trim().length === 0) {
        return res.status(400).json({ error: "Valid name is required" });
      }

      if (!req.files || !Array.isArray(req.files) || req.files.length === 0) {
        return res.status(400).json({ error: "At least one recording is required" });
      }

      // Parse recording metadata
      const recordings = req.files.map((file, index) => {
        const metadataKey = `recordingMetadata[${index}]`;
        const metadataString = req.body[metadataKey];
        
        if (!metadataString) {
          throw new Error(`Missing metadata for recording ${index}`);
        }

        const metadata = JSON.parse(metadataString);
        
        return {
          buffer: file.buffer,
          metadata: {
            id: metadata.id,
            duration: metadata.duration,
            quality: metadata.quality,
          },
        };
      });

      // Validate family access if familyId provided
      if (familyId) {
        const families = await storage.getFamiliesByUser(req.user!.id);
        const hasAccess = families.some(family => family.id === familyId);
        
        if (!hasAccess) {
          return res.status(403).json({ error: "Access denied to this family" });
        }
      }

      // Create voice job
      const job = await voiceJobService.createJob(
        name,
        req.user!.id,
        recordings,
        familyId
      );

      logger.info('Voice job created', {
        jobId: job.id,
        userId: req.user!.id,
        name,
        recordingCount: recordings.length,
      });

      metricsService.recordMetric({
        name: 'voice_jobs_created_total',
        value: 1,
        unit: 'count',
        tags: { userId: req.user!.id }
      });

      res.status(201).json(job);
    } catch (error: any) {
      logger.error('Voice job creation failed', {
        error: error.message,
        userId: req.user!.id,
      });

      metricsService.recordError({
        type: 'voice_job_creation_error',
        message: error.message,
        path: '/api/voice-jobs',
        userId: req.user!.id,
      });

      res.status(400).json({ error: error.message || "Failed to create voice job" });
    }
  });

  app.get('/api/voice-jobs', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const jobs = voiceJobService.getJobsByUser(req.user!.id);
      res.json(jobs);
    } catch (error: any) {
      logger.error('Get voice jobs failed', {
        error: error.message,
        userId: req.user!.id,
      });
      res.status(500).json({ error: "Failed to get voice jobs" });
    }
  });

  app.get('/api/voice-jobs/:jobId', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const job = voiceJobService.getJob(req.params.jobId);
      
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      if (job.userId !== req.user!.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      res.json(job);
    } catch (error: any) {
      logger.error('Get voice job failed', {
        error: error.message,
        jobId: req.params.jobId,
        userId: req.user!.id,
      });
      res.status(500).json({ error: "Failed to get voice job" });
    }
  });

  app.post('/api/voice-jobs/:jobId/cancel', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const job = voiceJobService.getJob(req.params.jobId);
      
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      if (job.userId !== req.user!.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      const cancelled = await voiceJobService.cancelJob(req.params.jobId);
      
      if (!cancelled) {
        return res.status(400).json({ error: "Job cannot be cancelled" });
      }

      logger.info('Voice job cancelled', {
        jobId: req.params.jobId,
        userId: req.user!.id,
      });

      res.json({ message: "Job cancelled successfully" });
    } catch (error: any) {
      logger.error('Cancel voice job failed', {
        error: error.message,
        jobId: req.params.jobId,
        userId: req.user!.id,
      });
      res.status(500).json({ error: "Failed to cancel voice job" });
    }
  });

  app.post('/api/voice-jobs/:jobId/retry', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const job = voiceJobService.getJob(req.params.jobId);
      
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      if (job.userId !== req.user!.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      const retriedJob = await voiceJobService.retryJob(req.params.jobId);
      
      if (!retriedJob) {
        return res.status(400).json({ error: "Job cannot be retried" });
      }

      logger.info('Voice job retried', {
        jobId: req.params.jobId,
        userId: req.user!.id,
      });

      res.json(retriedJob);
    } catch (error: any) {
      logger.error('Retry voice job failed', {
        error: error.message,
        jobId: req.params.jobId,
        userId: req.user!.id,
      });
      res.status(500).json({ error: "Failed to retry voice job" });
    }
  });

  // Voice job queue status (admin only)
  app.get('/api/voice-jobs/queue/status', authenticateToken, requireRole(['admin']), (req, res) => {
    try {
      const status = voiceJobService.getQueueStatus();
      res.json(status);
    } catch (error: any) {
      logger.error('Get queue status failed', { error: error.message });
      res.status(500).json({ error: "Failed to get queue status" });
    }
  });

  if (!config.FEATURE_STORY_MODE) {
    app.get('/api/stories', authenticateToken, async (req: AuthRequest, res) => {
      try {
        const category = typeof req.query.category === 'string' && req.query.category.trim()
          ? req.query.category.trim()
          : undefined;

        const stories = await storage.getStoriesForUser(req.user!.id, { category });
        res.json(stories);
      } catch (error) {
        console.error('Get stories error:', error);
        res.status(500).json({ error: "Failed to fetch stories" });
      }
    });

    app.post('/api/stories', authenticateToken, aiRateLimit, async (req: AuthRequest, res) => {
      try {
        const payload = storyGenerationSchema.parse(req.body);
        const userId = req.user!.id;

        let existingStory;
        if (payload.storyId) {
          const storyCheck = await userCanAccessStory(payload.storyId, userId);
          if (!storyCheck.story) {
            return res.status(404).json({ error: "Story not found" });
          }
          if (!storyCheck.allowed) {
            return res.status(403).json({ error: "Access denied" });
          }
          existingStory = storyCheck.story;
        }

        const effectiveFamilyId = existingStory?.familyId ?? payload.familyId;
        if (effectiveFamilyId) {
          const family = await storage.getFamily(effectiveFamilyId);
          if (!family) {
            return res.status(404).json({ error: "Family not found" });
          }

          const allowed = await userHasFamilyAccess(effectiveFamilyId, userId);
          if (!allowed) {
            return res.status(403).json({ error: "Access denied" });
          }
        }

        if (payload.generateNarrations && !payload.voiceProfileId) {
          return res.status(400).json({ error: "voiceProfileId is required when generateNarrations is true" });
        }

        if (payload.voiceProfileId) {
          const voiceProfile = await storage.getVoiceProfile(payload.voiceProfileId);
          if (!voiceProfile) {
            return res.status(404).json({ error: "Voice profile not found" });
          }

          if (voiceProfile.userId !== userId) {
            if (voiceProfile.familyId) {
              const allowed = await userHasFamilyAccess(voiceProfile.familyId, userId);
              if (!allowed) {
                return res.status(403).json({ error: "Access denied" });
              }
            } else {
              return res.status(403).json({ error: "Access denied" });
            }
          }

          if (voiceProfile.status !== 'ready') {
            return res.status(400).json({ error: "Voice profile is not ready" });
          }
        }

        const result = await storyService.generateStory({
          storyId: payload.storyId,
          familyId: effectiveFamilyId,
          userId,
          category: payload.category,
          title: payload.title,
          generateNarrations: payload.generateNarrations ?? false,
          voiceProfileId: payload.voiceProfileId,
        });

        res.status(existingStory ? 200 : 201).json(result);
      } catch (error: any) {
        console.error('Story generation error:', error);
        res.status(400).json({ error: error.message || "Failed to generate story" });
      }
    });

    app.post('/api/stories/:id/narrations', authenticateToken, aiRateLimit, async (req: AuthRequest, res) => {
      try {
        const { voiceProfileId } = storyNarrationSchema.parse(req.body);
        const userId = req.user!.id;

        const storyCheck = await userCanAccessStory(req.params.id, userId);
        if (!storyCheck.story) {
          return res.status(404).json({ error: "Story not found" });
        }
        if (!storyCheck.allowed) {
          return res.status(403).json({ error: "Access denied" });
        }

        const voiceProfile = await storage.getVoiceProfile(voiceProfileId);
        if (!voiceProfile) {
          return res.status(404).json({ error: "Voice profile not found" });
        }

        if (voiceProfile.userId !== userId) {
          if (voiceProfile.familyId) {
            const allowed = await userHasFamilyAccess(voiceProfile.familyId, userId);
            if (!allowed) {
              return res.status(403).json({ error: "Access denied" });
            }
          } else {
            return res.status(403).json({ error: "Access denied" });
          }
        }

        if (voiceProfile.status !== 'ready') {
          return res.status(400).json({ error: "Voice profile is not ready" });
        }

        const narrations = await storyService.generateNarrations({
          storyId: storyCheck.story.id,
          voiceProfileId,
          userId,
        });

        res.status(201).json({ story: storyCheck.story, narrations });
      } catch (error: any) {
        console.error('Generate story narrations error:', error);
        res.status(400).json({ error: error.message || "Failed to generate story narrations" });
      }
    });

    app.get('/api/stories/:id/narrations', authenticateToken, async (req: AuthRequest, res) => {
      try {
        const storyCheck = await userCanAccessStory(req.params.id, req.user!.id);
        if (!storyCheck.story) {
          return res.status(404).json({ error: "Story not found" });
        }
        if (!storyCheck.allowed) {
          return res.status(403).json({ error: "Access denied" });
        }

        const narrations = await storyService.getStoryNarrations(storyCheck.story.id);
        const withSignedUrls = narrations.map(narration => ({
          ...narration,
          audioSignedUrl: narration.audioUrl ?? null,
        }));

        res.json({ story: storyCheck.story, narrations: withSignedUrls });
      } catch (error) {
        console.error('Get story narrations error:', error);
        res.status(500).json({ error: "Failed to get story narrations" });
      }
    });
  }

  // AI content generation routes
  app.post('/api/ai/video-script', authenticateToken, aiRateLimit, async (req: AuthRequest, res) => {
    try {
      const { prompt, familyId } = req.body;
      if (!prompt) {
        return res.status(400).json({ error: "Prompt is required" });
      }

      const script = await videoService.generateVideoScript(prompt, familyId);
      res.json({ script });
    } catch (error: any) {
      console.error('Generate video script error:', error);
      res.status(400).json({ error: error.message || "Failed to generate video script" });
    }
  });

  // Auto-generate kids story and convert to speech
  app.post('/api/ai/auto-story/:voiceProfileId', authenticateToken, aiRateLimit, async (req: AuthRequest, res) => {
    try {
      const { voiceProfileId } = req.params;
      const { familyId } = req.body;
      
      // Check if voice profile exists and user has access
      const profile = await storage.getVoiceProfile(voiceProfileId);
      if (!profile) {
        return res.status(404).json({ error: "Voice profile not found" });
      }
      
      if (profile.userId !== req.user!.id) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      if (profile.status !== 'ready') {
        return res.status(400).json({ error: "Voice profile is not ready yet" });
      }
      
      // Get family context for personalized story
      const familyContext = familyId ? await storage.getFamily(familyId) : null;
      
      // Generate kids story using AI
      const { aiService } = await import('./services/aiService');
      const story = await aiService.generateKidsStory(familyContext);
      
      // Generate speech from the story
      const generationId = await voiceService.generateSpeech(
        voiceProfileId,
        story,
        req.user!.id
      );
      
      const generation = await storage.getVoiceGeneration(generationId);
      
      res.json({ 
        story,
        generation,
        message: "Story generated and converted to speech successfully"
      });
    } catch (error: any) {
      console.error('Auto-story generation error:', error);
      res.status(500).json({ error: error.message || "Failed to generate auto-story" });
    }
  });

  app.post('/api/ai/enhance-description', authenticateToken, aiRateLimit, async (req: AuthRequest, res) => {
    try {
      const { description } = req.body;
      if (!description) {
        return res.status(400).json({ error: "Description is required" });
      }

      const enhanced = await videoService.enhanceVideoDescription(description);
      res.json({ enhanced });
    } catch (error: any) {
      console.error('Enhance description error:', error);
      res.status(400).json({ error: error.message || "Failed to enhance description" });
    }
  });

  app.post('/api/ai/narration-script', authenticateToken, aiRateLimit, async (req: AuthRequest, res) => {
    try {
      const { videoContent, voicePersonality } = req.body;
      if (!videoContent) {
        return res.status(400).json({ error: "Video content is required" });
      }

      const script = await videoService.generateNarrationScript(videoContent, voicePersonality);
      res.json({ script });
    } catch (error: any) {
      console.error('Generate narration script error:', error);
      res.status(400).json({ error: error.message || "Failed to generate narration script" });
    }
  });

  // Collaboration routes
  app.get('/api/videos/:videoId/collaborators', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const collaborators = await collaborationService.getActiveCollaborators(req.params.videoId);
      res.json(collaborators);
    } catch (error) {
      console.error('Get collaborators error:', error);
      res.status(500).json({ error: "Failed to get collaborators" });
    }
  });

  app.get('/api/videos/:videoId/collaboration-stats', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const stats = collaborationService.getCollaborationStats(req.params.videoId);
      res.json(stats);
    } catch (error) {
      console.error('Get collaboration stats error:', error);
      res.status(500).json({ error: "Failed to get collaboration stats" });
    }
  });

  // Activity feed routes
  app.get('/api/families/:familyId/activities', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const { limit = 10 } = req.query;
      const activities = await storage.getRecentActivities(
        req.params.familyId, 
        parseInt(limit as string)
      );
      res.json(activities);
    } catch (error) {
      console.error('Get activities error:', error);
      res.status(500).json({ error: "Failed to get activities" });
    }
  });

  // Serve uploaded audio files
  app.use('/uploads', express.static(path.resolve(process.cwd(), 'uploads')));

  const httpServer = createServer(app);

  // Initialize WebSocket for real-time collaboration
  collaborationService.initializeWebSocket(httpServer);

  return httpServer;
}
