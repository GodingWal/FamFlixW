import { Router, Response } from 'express';
import { db } from '../db.js';
import { sql } from 'drizzle-orm';
import { authenticateToken, AuthRequest } from '../middleware/auth-simple.js';
import { videoService } from '../services/videoService';
import { storage } from '../storage';
import path from 'path';
import fs from 'fs/promises';
import { spawn } from 'child_process';

const router = Router();

// Ensure template_videos table exists (runtime guard)
async function ensureTemplateVideosTable() {
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS template_videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      thumbnail_url TEXT,
      video_url TEXT NOT NULL,
      duration INTEGER,
      category TEXT DEFAULT 'general',
      tags TEXT DEFAULT '[]',
      difficulty TEXT DEFAULT 'easy',
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

async function setProjectProgress(projectId: string | number, progress: number, stage: string) {
  try {
    const now = new Date().toISOString();
    const row = await db.get(sql`SELECT metadata FROM video_projects WHERE id = ${projectId}`);
    let meta: any = {};
    try {
      meta = row?.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : {};
    } catch {
      meta = {};
    }
    const history = Array.isArray(meta.processingHistory) ? meta.processingHistory : [];
    history.push({ status: stage, timestamp: now });
    meta.processingHistory = history;
    await db.run(sql`
      UPDATE video_projects
      SET processing_progress = ${progress}, metadata = ${JSON.stringify(meta)}, updated_at = ${now}
      WHERE id = ${projectId}
    `);
  } catch (e) {
    console.error('[processing] Failed to set progress:', e);
  }
}

function toLocalUploadsPath(url: string): string {
  if (!url || !url.startsWith('/uploads/')) {
    throw new Error(`Unsupported uploads URL: ${url}`);
  }
  return path.join(process.cwd(), url.replace(/^\/+/, ''));
}

// Run the Python voice replacement pipeline
async function runVoiceReplacementPipeline(inputVideoPath: string, outputVideoPath: string, promptWavPath: string): Promise<void> {
  await fs.mkdir(path.dirname(outputVideoPath), { recursive: true });

  const pythonBin = process.env.PYTHON_BIN || 'python3';
  const scriptPath = path.resolve(process.cwd(), 'scripts', 'voice_replace_pipeline.py');
  const args: string[] = [
    scriptPath,
    '--input-video', inputVideoPath,
    '--output-video', outputVideoPath,
    '--audio-prompt', promptWavPath,
    '--device', String(process.env.CHATTERBOX_DEVICE || 'cpu'),
  ];

  // Optional: override the Whisper model for transcription (e.g., tiny, base, small, medium)
  const whisperModel = process.env.WHISPER_MODEL;
  if (whisperModel && whisperModel.length > 0) {
    args.push('--whisper-model', whisperModel);
  }

  // Prefer faster-whisper for transcription by default; allow override via env
  const transcriber = String(process.env.TRANSCRIBER || 'faster-whisper');
  args.push('--transcriber', transcriber);

  // Optional: direct CTranslate2 settings for faster-whisper
  const ct2Device = process.env.WHISPER_CT2_DEVICE || undefined;
  const ct2Compute = process.env.WHISPER_CT2_COMPUTE || undefined;
  const ct2Beam = process.env.WHISPER_CT2_BEAM || undefined;
  if (ct2Device) {
    args.push('--ct2-device', ct2Device);
  }
  if (ct2Compute) {
    args.push('--ct2-compute', ct2Compute);
  }
  if (ct2Beam) {
    args.push('--ct2-beam-size', ct2Beam);
  }

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(pythonBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', (e: Error) => reject(e));
    proc.on('close', (code: number | null) => {
      if (code === 0) return resolve();
      reject(new Error(`voice_replace_pipeline exited with code ${code}: ${stderr}`));
    });
  });
}

async function ensureVideoProjectsTable() {
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS video_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      template_video_id INTEGER NOT NULL,
      voice_profile_id INTEGER,
      face_image_url TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      output_video_url TEXT,
      processing_progress INTEGER DEFAULT 0,
      processing_error TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (template_video_id) REFERENCES template_videos(id) ON DELETE CASCADE
    )
  `);

  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_video_projects_user_id ON video_projects(user_id)
  `);

  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_video_projects_status ON video_projects(status)
  `);

  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_video_projects_template_id ON video_projects(template_video_id)
  `);
}

// Runtime migration: ensure user_id column is TEXT (matching users.id)
async function migrateVideoProjectsUserIdTypeIfNeeded() {
  try {
    const columns = await db.all(sql`PRAGMA table_info(video_projects)`);
    const userIdCol = Array.isArray(columns) ? (columns as any[]).find(c => c.name === 'user_id') : null;
    if (userIdCol && typeof userIdCol.type === 'string' && /int/i.test(userIdCol.type)) {
      // Perform SQLite table rebuild to change column type
      await db.run(sql`PRAGMA foreign_keys = OFF`);
      await db.run(sql.raw(`BEGIN TRANSACTION`));
      await db.run(sql.raw(`
        CREATE TABLE IF NOT EXISTS video_projects_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          template_video_id INTEGER NOT NULL,
          voice_profile_id INTEGER,
          face_image_url TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          output_video_url TEXT,
          processing_progress INTEGER DEFAULT 0,
          processing_error TEXT,
          metadata TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (template_video_id) REFERENCES template_videos(id) ON DELETE CASCADE
        )
      `));
      await db.run(sql.raw(`
        INSERT INTO video_projects_new (
          id, user_id, template_video_id, voice_profile_id, face_image_url,
          status, output_video_url, processing_progress, processing_error, metadata,
          created_at, updated_at, completed_at
        )
        SELECT 
          id,
          CAST(user_id AS TEXT),
          template_video_id,
          voice_profile_id,
          face_image_url,
          status,
          output_video_url,
          processing_progress,
          processing_error,
          metadata,
          created_at,
          updated_at,
          completed_at
        FROM video_projects
      `));
      await db.run(sql.raw(`DROP TABLE video_projects`));
      await db.run(sql.raw(`ALTER TABLE video_projects_new RENAME TO video_projects`));
      await db.run(sql.raw(`CREATE INDEX IF NOT EXISTS idx_video_projects_user_id ON video_projects(user_id)`));
      await db.run(sql.raw(`CREATE INDEX IF NOT EXISTS idx_video_projects_status ON video_projects(status)`));
      await db.run(sql.raw(`CREATE INDEX IF NOT EXISTS idx_video_projects_template_id ON video_projects(template_video_id)`));
      await db.run(sql.raw(`COMMIT`));
      await db.run(sql`PRAGMA foreign_keys = ON`);
      console.log('[migrate] video_projects.user_id migrated to TEXT');
    }
  } catch (err) {
    console.error('[migrate] Failed to migrate video_projects.user_id to TEXT:', err);
  }
}

// Create a new video project
router.post('/api/video-projects', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { templateVideoId, voiceProfileId, faceImageUrl, metadata } = req.body;
    const userId = req.user!.id;

    if (templateVideoId === undefined || templateVideoId === null) {
      return res.status(400).json({ error: 'Template video ID is required' });
    }

    const templateVideoIdNumber = Number(templateVideoId);
    if (!Number.isInteger(templateVideoIdNumber) || templateVideoIdNumber <= 0) {
      return res.status(400).json({ error: 'Template video ID must be a positive integer' });
    }

    // Ensure required tables exist and verify template video exists
    await ensureTemplateVideosTable();
    const templateVideo = await db.get(sql`
      SELECT id FROM template_videos WHERE id = ${templateVideoIdNumber} AND is_active = 1
    `);

    if (!templateVideo) {
      return res.status(404).json({ error: 'Template video not found' });
    }

    await ensureVideoProjectsTable();
    await migrateVideoProjectsUserIdTypeIfNeeded();

    const now = new Date();
    const result = await db.run(sql`
      INSERT INTO video_projects (
        user_id, template_video_id, voice_profile_id, face_image_url,
        status, processing_progress, metadata, created_at, updated_at
      ) VALUES (
        ${userId}, ${templateVideoIdNumber}, ${voiceProfileId || null}, 
        ${faceImageUrl || null}, 'pending', 0, ${metadata ? JSON.stringify(metadata) : null},
        ${now.toISOString()}, ${now.toISOString()}
      )
    `);

    const insertedId =
      typeof result?.lastInsertRowid === 'number'
        ? result.lastInsertRowid
        : typeof result?.lastID === 'number'
        ? result.lastID
        : null;

    if (!insertedId) {
      throw new Error('Unable to determine newly created project ID');
    }

    const project = await db.get(sql`
      SELECT vp.*, tv.title as template_title, tv.thumbnail_url as template_thumbnail
      FROM video_projects vp
      JOIN template_videos tv ON vp.template_video_id = tv.id
      WHERE vp.id = ${insertedId}
    `);

    // Also create a corresponding entry in the main videos table so it appears in the library
    try {
      const initialVideo = await videoService.createVideo({
        title: project.template_title,
        description: project.metadata?.description ?? project.description ?? null,
        thumbnail: project.template_thumbnail ?? null,
        videoUrl: null, // will be filled when rendering completes
        duration: project.duration ?? null,
        status: 'draft',
        type: 'user_project',
        familyId: null,
        createdBy: userId,
        metadata: {
          projectId: insertedId,
          templateVideoId: templateVideoIdNumber,
        },
      } as any);

      // Persist a backlink to the created video on the project row (in metadata)
      let meta: any = null;
      try {
        meta = project?.metadata ? (typeof project.metadata === 'string' ? JSON.parse(project.metadata) : project.metadata) : {};
      } catch {
        meta = {};
      }
      meta.linkedVideoId = initialVideo.id;
      await db.run(sql`
        UPDATE video_projects SET metadata = ${JSON.stringify(meta)}, updated_at = ${new Date().toISOString()} WHERE id = ${insertedId}
      `);

      res.status(201).json({ ...project, linkedVideoId: initialVideo.id });
    } catch (linkErr) {
      // If creating the library video fails, still return the project so the flow can continue
      console.error('Failed to create linked library video:', linkErr);
      res.status(201).json(project);
    }
  } catch (error) {
    console.error('Error creating video project:', error);
    res.status(500).json({ error: 'Failed to create video project' });
  }
});

// Get all projects for the authenticated user
router.get('/api/video-projects', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const projects = await db.all(sql`
      SELECT vp.*, tv.title as template_title, tv.thumbnail_url as template_thumbnail,
             tv.category, tv.duration as template_duration
      FROM video_projects vp
      JOIN template_videos tv ON vp.template_video_id = tv.id
      WHERE vp.user_id = ${userId}
      ORDER BY vp.created_at DESC
    `);

    res.json(projects);
  } catch (error) {
    console.error('Error fetching video projects:', error);
    res.status(500).json({ error: 'Failed to fetch video projects' });
  }
});

// Get a specific project
router.get('/api/video-projects/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const project = await db.get(sql`
      SELECT vp.*, tv.title as template_title, tv.thumbnail_url as template_thumbnail,
             tv.video_url as template_video_url, tv.category, tv.difficulty
      FROM video_projects vp
      JOIN template_videos tv ON vp.template_video_id = tv.id
      WHERE vp.id = ${id} AND vp.user_id = ${userId}
    `);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    res.json(project);
  } catch (error) {
    console.error('Error fetching video project:', error);
    res.status(500).json({ error: 'Failed to fetch video project' });
  }
});

// Update project (add voice/face, update status)
router.patch('/api/video-projects/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;
    const { voiceProfileId, faceImageUrl, status, processingProgress, outputVideoUrl, metadata } = req.body;

    // Verify ownership
    const existing = await db.get(sql`
      SELECT id FROM video_projects WHERE id = ${id} AND user_id = ${userId}
    `);

    if (!existing) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Build assignment list using Drizzle SQL template to ensure proper parameter binding
    const assignments: any[] = [];

    if (voiceProfileId !== undefined) {
      assignments.push(sql`voice_profile_id = ${voiceProfileId}`);
    }
    if (faceImageUrl !== undefined) {
      assignments.push(sql`face_image_url = ${faceImageUrl}`);
    }
    if (status !== undefined) {
      assignments.push(sql`status = ${status}`);
      if (status === 'completed') {
        assignments.push(sql`completed_at = ${new Date().toISOString()}`);
      }
    }
    if (processingProgress !== undefined) {
      assignments.push(sql`processing_progress = ${processingProgress}`);
    }
    if (outputVideoUrl !== undefined) {
      assignments.push(sql`output_video_url = ${outputVideoUrl}`);
    }
    if (metadata !== undefined) {
      assignments.push(sql`metadata = ${JSON.stringify(metadata)}`);
    }

    assignments.push(sql`updated_at = ${new Date().toISOString()}`);

    if (assignments.length > 0) {
      await db.run(sql`
        UPDATE video_projects 
        SET ${sql.join(assignments, sql`, `)} 
        WHERE id = ${id}
      `);
    }

    const updated = await db.get(sql`
      SELECT vp.*, tv.title as template_title, tv.thumbnail_url as template_thumbnail
      FROM video_projects vp
      JOIN template_videos tv ON vp.template_video_id = tv.id
      WHERE vp.id = ${id}
    `);

    res.json(updated);
  } catch (error) {
    console.error('Error updating video project:', error);
    res.status(500).json({ error: 'Failed to update video project' });
  }
});

// Delete project
router.delete('/api/video-projects/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const result = await db.run(sql`
      DELETE FROM video_projects WHERE id = ${id} AND user_id = ${userId}
    `);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    res.json({ message: 'Project deleted successfully' });
  } catch (error) {
    console.error('Error deleting video project:', error);
    res.status(500).json({ error: 'Failed to delete video project' });
  }
});

// Start processing a project
router.post('/api/video-projects/:id/process', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const project = await db.get(sql`
      SELECT * FROM video_projects WHERE id = ${id} AND user_id = ${userId}
    `);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Processing currently requires only a voice profile; face image is optional (feature disabled)
    if (!project.voice_profile_id) {
      return res.status(400).json({ 
        error: 'Voice profile is required to start processing' 
      });
    }

    // Update status to processing
    const processingStartedAt = new Date().toISOString();
    await db.run(sql`
      UPDATE video_projects
      SET status = 'processing', processing_progress = 0, updated_at = ${processingStartedAt}
      WHERE id = ${id}
    `);

    // Also mark the linked video as processing so it shows up in the library immediately
    const projectWithMeta = await db.get(sql`
      SELECT vp.*, tv.title as template_title, tv.video_url as template_video_url, tv.thumbnail_url as template_thumbnail
      FROM video_projects vp
      JOIN template_videos tv ON vp.template_video_id = tv.id
      WHERE vp.id = ${id}
    `);

    let linkedVideoId: string | undefined;
    try {
      const meta = projectWithMeta?.metadata ? (typeof projectWithMeta.metadata === 'string' ? JSON.parse(projectWithMeta.metadata) : projectWithMeta.metadata) : {};
      linkedVideoId = meta?.linkedVideoId;
    } catch {
      linkedVideoId = undefined;
    }

    if (linkedVideoId) {
      try {
        await videoService.updateVideo(linkedVideoId, { status: 'processing' } as any, userId);
      } catch (updateErr) {
        console.error('Failed to mark linked video processing:', updateErr);
      }
    }

    // Acknowledge the request immediately; perform processing asynchronously
    res.json({ message: 'Processing started', projectId: id, linkedVideoId: linkedVideoId ?? null });

    // Begin real voice replacement pipeline asynchronously
    (async () => {
      try {
        await setProjectProgress(id, 5, 'starting');
        // Resolve input video path from template video URL
        const templateUrl: string | null = projectWithMeta?.template_video_url ?? null;
        if (!templateUrl) {
          throw new Error('Template video URL not found for project');
        }
        const inputVideoPath = toLocalUploadsPath(templateUrl);
        console.log('[processing] input video path:', inputVideoPath);

        // Resolve voice prompt path from selected voice profile
        const profileId = String(project.voice_profile_id);
        const profile = await storage.getVoiceProfile(profileId);
        if (!profile) {
          throw new Error('Selected voice profile not found');
        }
        const promptPath = (profile as any).providerRef || (profile.metadata as any)?.chatterbox?.audioPromptPath;
        if (!promptPath) {
          throw new Error('Voice profile is missing an audio prompt path');
        }
        console.log('[processing] prompt wav path:', promptPath);

        // Determine output file location under uploads/videos
        const outputFileName = `processed-${id}.mp4`;
        const outputUrl = `/uploads/videos/${outputFileName}`;
        const outputVideoPath = toLocalUploadsPath(outputUrl);
        console.log('[processing] output video path:', outputVideoPath);

        // Run the Python voice replacement pipeline
        await setProjectProgress(id, 15, 'pipeline_spawn');
        await runVoiceReplacementPipeline(inputVideoPath, outputVideoPath, promptPath);

        const completionTimestamp = new Date().toISOString();
        // Update project record on success
        let meta: any = null;
        try {
          meta = projectWithMeta?.metadata
            ? typeof projectWithMeta.metadata === 'string'
              ? JSON.parse(projectWithMeta.metadata)
              : projectWithMeta.metadata
            : {};
        } catch {
          meta = {};
        }
        const history = Array.isArray(meta?.processingHistory) ? meta.processingHistory : [];
        history.push({ status: 'completed', timestamp: completionTimestamp });
        meta.processingHistory = history;
        meta.processingCompletedAt = completionTimestamp;

        await db.run(sql`
          UPDATE video_projects
          SET
            status = 'completed',
            processing_progress = 100,
            output_video_url = ${outputUrl},
            metadata = ${JSON.stringify(meta)},
            updated_at = ${completionTimestamp},
            completed_at = ${completionTimestamp}
          WHERE id = ${id}
        `);

        console.log('[processing] completed. output url:', outputUrl);
        if (linkedVideoId) {
          try {
            const linkedVideoUpdates: Record<string, unknown> = {
              status: 'completed',
              videoUrl: outputUrl,
            };
            if (projectWithMeta?.template_thumbnail) {
              linkedVideoUpdates.thumbnail = projectWithMeta.template_thumbnail;
            }
            await videoService.updateVideo(linkedVideoId, linkedVideoUpdates as any, userId);
          } catch (finalizeErr) {
            console.error('Failed to finalize linked video:', finalizeErr);
          }
        }
      } catch (err: any) {
        console.error('[processing] Voice replacement failed:', err?.message || err);
        const failedAt = new Date().toISOString();
        await db.run(sql`
          UPDATE video_projects
          SET
            status = 'failed',
            processing_progress = 100,
            processing_error = ${String(err?.message || 'Voice replacement failed')},
            updated_at = ${failedAt}
          WHERE id = ${id}
        `);
        // Optionally mark linked video as error (schema uses 'error')
        if (linkedVideoId) {
          try {
            await videoService.updateVideo(linkedVideoId, { status: 'error' } as any, userId);
          } catch (e) {
            console.error('Failed to mark linked video failed:', e);
          }
        }
      }
    })();
  } catch (error) {
    console.error('Error starting video processing:', error);
    res.status(500).json({ error: 'Failed to start processing' });
  }
});

export default router;
