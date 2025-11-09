import 'dotenv/config';
import express, { type Request, Response, NextFunction, Express } from "express";
import { createServer, type Server } from "http";
import path from "path";
import bcrypt from "bcryptjs";
import { z } from "zod";
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { storage } from "./storage";
import { 
  generateAccessToken, 
  generateRefreshToken, 
  authenticateToken, 
  refreshTokens,
  type AuthRequest 
} from "./middleware/auth-simple";
import templateVideosRouter from "./routes/templateVideos.js";
import videoProjectsRouter from "./routes/videoProjects.js";
import storiesRouter from "./routes/stories.js";
import adminRouter from "./routes/admin.js";
import { generalRateLimit, authRateLimit } from "./middleware/rateLimiter";
import { voiceService } from "./services/voiceService";
import { voiceJobService } from "./services/voiceJobService";
import { videoService } from "./services/videoService";
import {
  insertUserSchema,
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

const checkoutSchema = z.object({
  plan: z.enum(subscriptionPlans).refine((plan) => plan !== "free", {
    message: "Select a paid plan to upgrade.",
  }),
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
  // Apply general rate limiting to all routes
  app.use('/api', generalRateLimit);

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

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Register new routes
  app.use(templateVideosRouter);
  app.use(videoProjectsRouter);
  // Enable Story Mode routes when the feature flag is set
  if (process.env.FEATURE_STORY_MODE === 'true') {
    app.use(storiesRouter);
  }
  app.use('/api/admin', authenticateToken, adminRouter);

  // Serve audio files securely (previews and TTS generations)
  app.get('/api/audio/:filename', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const user = req.user!;
      const filename = req.params.filename;

      // Basic validation to block traversal
      if (!/^[a-zA-Z0-9_-]+\.(wav|mp3|webm|ogg)$/.test(filename)) {
        return res.status(400).json({ error: 'Invalid filename' });
      }

      const pathMod = await import('path');
      const fsMod = await import('fs');
      const audioFilePath = pathMod.join(process.cwd(), 'temp', filename);

      const audioUrl = `/api/audio/${filename}`;
      let accessGranted = false;

      // Case 1: Voice preview/generation audio
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
              const members = await storage.getFamilyMembers(voiceProfile.familyId);
              accessGranted = Array.isArray(members) && members.some((m: any) => m.id === user.id || (m as any).userId === user.id);
            }
          }
        }
      }

      // Case 2: Story narration audio (generated by Story Mode)
      if (!accessGranted) {
        const storyAudioEntry = await storage.getStoryAudioByAudioUrl(audioUrl);
        if (storyAudioEntry) {
          const voiceProfile = await storage.getVoiceProfile(storyAudioEntry.voiceId);
          if (voiceProfile) {
            if (voiceProfile.userId === user.id) {
              accessGranted = true;
            } else if (voiceProfile.familyId) {
              const members = await storage.getFamilyMembers(voiceProfile.familyId);
              accessGranted = Array.isArray(members) && members.some((m: any) => m.id === user.id || (m as any).userId === user.id);
            }
          }
        }
      }

      if (!accessGranted) {
        return res.status(403).json({ error: 'Access denied' });
      }

      try {
        await fsMod.promises.access(audioFilePath);

        // Set headers for streaming
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'public, max-age=3600');

        const fileStream = fsMod.createReadStream(audioFilePath);
        fileStream.pipe(res);
      } catch (fileErr) {
        console.error('Audio file not found:', audioFilePath);
        res.status(404).json({ error: 'Audio file not found' });
      }
    } catch (error) {
      console.error('Audio serving error (simple):', error);
      res.status(500).json({ error: 'Failed to serve audio file' });
    }
  });

  // Videos API (needed by Video Library and Dashboard)
  app.get('/api/videos', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const familyId = typeof req.query.familyId === 'string' ? req.query.familyId : undefined;
      const videos = familyId
        ? await videoService.getVideosByFamily(familyId)
        : await videoService.getVideosByUser(req.user!.id);
      res.json(videos);
    } catch (error) {
      console.error('Get videos error:', error);
      res.status(500).json({ error: 'Failed to get videos' });
    }
  });

  app.get('/api/videos/:videoId', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const video = await storage.getVideo(req.params.videoId);
      if (!video) {
        return res.status(404).json({ error: 'Video not found' });
      }
      res.json(video);
    } catch (error) {
      console.error('Get video error:', error);
      res.status(500).json({ error: 'Failed to get video' });
    }
  });

  app.put('/api/videos/:videoId', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const updates = req.body;
      const video = await videoService.updateVideo(req.params.videoId, updates, req.user!.id);
      res.json(video);
    } catch (error: any) {
      console.error('Update video error:', error);
      res.status(400).json({ error: error.message || 'Failed to update video' });
    }
  });

  app.delete('/api/videos/:videoId', authenticateToken, async (req: AuthRequest, res) => {
    try {
      await videoService.deleteVideo(req.params.videoId, req.user!.id);
      res.json({ message: 'Video deleted successfully' });
    } catch (error: any) {
      console.error('Delete video error:', error);
      res.status(400).json({ error: error.message || 'Failed to delete video' });
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

      // Generate tokens
      const accessToken = generateAccessToken(user.id);
      const refreshToken = generateRefreshToken(user.id);

      // Set httpOnly cookies
      res.cookie('accessToken', accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 15 * 60 * 1000, // 15 minutes
      });

      res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      });

      res.status(201).json({
        message: "User created successfully",
        accessToken,
        user: serializeUser(user),
      });
    } catch (error: any) {
      console.error('Registration error:', error);
      res.status(400).json({ error: error.message || "Registration failed" });
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
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 15 * 60 * 1000, // 15 minutes
      });

      res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      });

      res.json({
        message: "Login successful",
        accessToken,
        user: serializeUser(user),
      });
    } catch (error: any) {
      console.error('Login error:', error);
      res.status(400).json({ error: error.message || "Login failed" });
    }
  });

  // Token refresh endpoint
  app.post('/api/auth/refresh', refreshTokens);

  // Logout endpoint
  app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('accessToken');
    res.clearCookie('refreshToken');
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
      console.error('Checkout session creation failed:', error);
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
      console.error('Stripe webhook processing error:', error);
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

      console.error('Failed to load ad preferences:', error);
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

      console.error('Failed to update ad preferences:', error);
      res.status(500).json({ error: 'Unable to update ad preferences' });
    }
  });

  // Family management routes
  app.post('/api/families', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const familyData = {
        ...req.body,
        ownerId: req.user!.id,
      };

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

  // Voice profile routes
  app.post('/api/voice-profiles', authenticateToken, upload.single('audio'), async (req: AuthRequest, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "Audio file is required" });
      }

      const { name, familyId } = req.body;
      
      if (!name || name.trim().length === 0) {
        return res.status(400).json({ error: "Valid name is required" });
      }

      // Create voice profile using the voice service
      const voiceProfileId = await voiceService.createVoiceClone(
        req.file.buffer,
        name,
        req.user!.id,
        familyId
      );

      const voiceProfile = await storage.getVoiceProfile(voiceProfileId);
      res.status(201).json(voiceProfile);
    } catch (error: any) {
      console.error('Voice profile creation error:', error);
      res.status(400).json({ error: error.message || "Failed to create voice profile" });
    }
  });

  app.get('/api/voice-profiles', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const profiles = await storage.getVoiceProfilesByUser(req.user!.id);
      res.json(profiles);
    } catch (error: any) {
      console.error('Get voice profiles error:', error);
      res.status(500).json({ error: "Failed to get voice profiles" });
    }
  });

  // Delete a voice profile (owner only)
  app.delete('/api/voice-profiles/:profileId', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const { profileId } = req.params;
      const profile = await storage.getVoiceProfile(profileId);
      if (!profile) {
        return res.status(404).json({ error: 'Voice profile not found' });
      }

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

  // Voice preview: short kids story (~20s) + TTS using selected voice
  app.post('/api/voice-profiles/:profileId/preview', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const profileId = req.params.profileId;
      const { familyId, targetSeconds = 20 } = req.body ?? {};

      const profile = await storage.getVoiceProfile(profileId);
      if (!profile) {
        return res.status(404).json({ error: 'Voice profile not found' });
      }
      if (profile.userId !== req.user!.id) {
        return res.status(403).json({ error: 'Access denied' });
      }
      if (profile.status !== 'ready') {
        return res.status(400).json({ error: 'Voice profile is not ready yet' });
      }

      const familyContext = familyId ? await storage.getFamily(familyId) : null;
      const { aiService } = await import('./services/aiService');
      const story = await aiService.generateKidsStory(familyContext, { targetSeconds: Number(targetSeconds) || 20 });

      let generation: any = null;
      try {
        const generationId = await voiceService.generateSpeech(profileId, story, req.user!.id);
        generation = await storage.getVoiceGeneration(generationId);
      } catch (ttsError: any) {
        console.error('TTS generation failed for preview (simple):', ttsError?.message || ttsError);
      }

      res.json({ story, generation, previewSeconds: Number(targetSeconds) || 20, ...(generation ? {} : { warning: 'TTS unavailable for preview' }) });
    } catch (error: any) {
      console.error('Voice preview error (simple):', error);
      res.status(400).json({ error: error.message || 'Failed to generate preview' });
    }
  });

  // Voice job management routes
  app.post('/api/voice-jobs', authenticateToken, generalRateLimit, upload.array('recordings'), async (req: AuthRequest, res) => {
    try {
      const { name, familyId } = req.body;
      
      // Debug logging
      console.log('Voice job request body keys:', Object.keys(req.body));
      console.log('Voice job request body:', req.body);
      console.log('Voice job files count:', req.files?.length);
      console.log('Auth header seen by server:', req.headers['authorization']);
      // req.cookies is available via cookie-parser
      // Log only presence, not values
      const cookieContainer = (req as Request & { cookies?: Record<string, unknown> }).cookies;
      console.log('Cookies present:', cookieContainer ? Object.keys(cookieContainer) : []);
      
      if (!name || name.trim().length === 0) {
        return res.status(400).json({ error: "Valid name is required" });
      }

      if (!req.files || !Array.isArray(req.files) || req.files.length === 0) {
        return res.status(400).json({ error: "At least one recording is required" });
      }

      // Parse recording metadata
      const body: any = req.body;
      const metaRoot: any = body.recordingMetadata ?? null;

      const getMetadataForIndex = (index: number): any => {
        // Prefer nested object/array structure produced by multer/append-field
        if (metaRoot != null) {
          if (Array.isArray(metaRoot)) {
            return metaRoot[index];
          } else if (typeof metaRoot === 'object') {
            return (metaRoot as any)[index] ?? (metaRoot as any)[String(index)];
          }
        }
        // Fallback to legacy bracketed key format
        const legacyKey = `recordingMetadata[${index}]`;
        const legacyVal = body[legacyKey];
        if (legacyVal !== undefined) {
          try {
            return typeof legacyVal === 'string' ? JSON.parse(legacyVal) : legacyVal;
          } catch {
            return legacyVal;
          }
        }
        return undefined;
      };

      const files = (req.files || []) as any[];
      const recordings = files.map((file, index) => {
        let metadata = getMetadataForIndex(index);
        // Parse JSON if metadata is a string
        if (typeof metadata === 'string') {
          try {
            metadata = JSON.parse(metadata);
          } catch (e) {
            console.warn(`Failed to parse metadata JSON for index ${index}:`, e);
          }
        }
        console.log(`Resolved metadata for index ${index}:`, metadata);
        
        if (!metadata) {
          throw new Error(`Missing metadata for recording ${index}`);
        }

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

      res.status(201).json(job);
    } catch (error: any) {
      console.error('Voice job creation error:', error);
      res.status(400).json({ error: error.message || "Failed to create voice job" });
    }
  });

  app.get('/api/voice-jobs', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const jobs = voiceJobService.getJobsByUser(req.user!.id);
      res.json(jobs);
    } catch (error: any) {
      console.error('Get voice jobs error:', error);
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
      console.error('Get voice job error:', error);
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
        return res.status(400).json({ error: "Cannot cancel this job" });
      }

      res.json({ message: "Job cancelled successfully" });
    } catch (error: any) {
      console.error('Cancel voice job error:', error);
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
        return res.status(400).json({ error: "Cannot retry this job" });
      }

      res.json(retriedJob);
    } catch (error: any) {
      console.error('Retry voice job error:', error);
      res.status(500).json({ error: "Failed to retry voice job" });
    }
  });

  // Serve uploaded files
  app.use('/uploads', express.static(path.resolve(process.cwd(), 'uploads')));

  // WebSocket server
  const server = createServer(app);
  
  return server;
}
